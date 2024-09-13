import { Browser, HTTPResponse, Page, PuppeteerLaunchOptions } from 'puppeteer';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { errorColor, logger, LogSource, speedColor, successColor } from '../common/logger';
import { ProcessingQueue, QueueEvent } from '../common/processing-queue';
import { delay, isNullOrUndefined, logMessage } from '../common/utils';
import { BandDatabase } from '../data/db';
import { BandSpiderOptions } from '../index';
import { AccountHandler } from './processors/account-handler';
import { ItemHandler } from './processors/item-handler';
import { ProxyClient } from './proxy/proxy-client';
import dns from 'dns/promises';

export enum UrlType {
	Account = 'account',
	Item = 'item',
}

export class BandSpider {
	private readonly accountHandler: AccountHandler = new AccountHandler();
	private readonly itemHandler: ItemHandler = new ItemHandler();
	private readonly usedIps: { [ip: string]: number } = {};
	private readonly statistic = {
		processed: 0,
		failed: 0,
		start: null
	};

	private database: BandDatabase;

	public async run(
		{
			concurrencyBrowsers,
			headless,
			type,
			docker,
		}: BandSpiderOptions
	): Promise<void> {
		puppeteer.use(StealthPlugin());

		// init database
		logger.info('DB creating...')
		this.database = await BandDatabase.initialize();
		await this.database.account.resetAllBusy();
		await this.database.item.resetAllBusy();
		logger.info('DB created');

		// init queue
		logger.info('Queue init...');
		const queue: ProcessingQueue = new ProcessingQueue(
			await this.getInitialUrlsToProcess(type),
			this.database
		);
		logger.info('Queue ready!');

		// change IP
		ProxyClient.initialize.changeIp();

		const browsers: Browser[] = [];
		process.on('SIGINT', () => {
			browsers.forEach(x => (x.close()));
			logger.warn('Browsers closed');
		});

		const promises: Promise<void>[] = Array.from({ length: concurrencyBrowsers })
			.map(async (_, id: number) => {
				const browser = await this.getBrowser(docker, headless);
				browsers.push(browser);

				const pages = await browser.pages();
				const page = isNullOrUndefined(pages) || pages.length === 0
					? await browser.newPage()
					: pages[0];

				const cdpSession = await page.createCDPSession();
				const clearPageCache = async (): Promise<void> => {
					try {
						await cdpSession.send('Network.clearBrowserCookies');
						await cdpSession.send('Network.clearBrowserCache');
					} catch (e) {
						logger.error(
							logMessage(LogSource.Browser, 'Clearing browser cache failed', e),
						);
					}
				};

				//if (headless) {
				await page.setCacheEnabled(false);

				await page.setRequestInterception(true);
				page.on('request', (request) => {
					if (['font', 'image', 'stylesheet', 'media'].includes(request.resourceType())) {
						request.abort();
						return;
					}

					if (request.method() === 'POST') {
						request.abort();
						return;
					}

					const url = request.url();
					if (
						url.includes('recaptcha')
						|| url.includes('bcbits.com')
						|| url.includes('gstatic.com')
						|| url.includes('googletagmanager.com')
						|| url.includes('google.com')
						|| url.includes('bandcamp.com/api/currency_data')
					) {
						request.abort();
						return;
					}

					request.continue();
				});
				//}

				page.on('response', async (httpResponse: HTTPResponse) => {
					if (httpResponse.status() !== 429) {
						return;
					}

					try {
						const url = new URL(httpResponse.url());
						const domain = url.hostname;
						const { address, family } = await dns.lookup(domain);
						console.log(address);
						console.log(family);
						
						ProxyClient.initialize.changeIp();
					}
					catch (e) {
						logger.error(e, logMessage(LogSource.Browser, '', httpResponse.url()))
					}
				});

				return this.startPageProcessing(
					page,
					queue,
					type,
					id,
					clearPageCache
				);
			});
		await Promise.all(promises)
	}

	private async startPageProcessing(
		page: Page,
		queue: ProcessingQueue,
		type: UrlType,
		id: number,
		clearPageCache: () => Promise<void>
	) {
		if (isNullOrUndefined(this.statistic.start)) {
			this.statistic.start = new Date().getTime()
		}
		while (true) {
			// do not make a call if changing of IP is in progress
			if (ProxyClient.initialize.isProcessing) {
				await delay();
				continue;
			}

			// fill queue
			if (queue.size === 0) {
				await this.enqueueFromDb(queue, type);
				if (queue.size === 0) {
					break;
				}
			}

			// dequeue 
			const event: QueueEvent = await queue.dequeue();
			if (isNullOrUndefined(event)) {
				continue;
			}

			// process
			const isProcessed = await this.processUrl(
				event,
				page,
				id,
				clearPageCache
			);

			// update statistic
			if (isProcessed) {
				this.statistic.processed++;
			} else {
				this.statistic.failed++;
			}

			if ((this.statistic.processed + this.statistic.failed) % 50 === 0) {
				logger.debug(
					logMessage(
						LogSource.Main,
						`Processed: ${successColor(this.statistic.processed).padEnd(4)}; Failed: ${errorColor(this.statistic.failed).padEnd(4)}; Speed: ${speedColor((this.statistic.processed / ((new Date().getTime() - this.statistic.start) / 1000)).toFixed(2)).padEnd(4)}`
							.padStart(240)
					)
				);

				if (this.statistic.processed * 1.5 < this.statistic.failed) {
					await page.browser().close();
					throw 'No sense to process!';
				}
			}
		}

		await page.close();
		logger.info(
			logMessage(LogSource.Browser, `[${String(id).padEnd(2)}] Completed!`)
		);
	}

	private async processUrl(
		event: QueueEvent,
		page: Page,
		pageIndex: number,
		clearPageCache: () => Promise<void>
	): Promise<boolean> {
		try {
			let processed = false;
			if (event.type === UrlType.Account) {
				await this.database.account.updateBusy(event.id, true);
				processed = await this.accountHandler.processAccount(page, event, pageIndex, clearPageCache);
				await this.database.account.updateBusy(event.id, false);
			} else if (event.type === UrlType.Item) {
				await this.database.item.updateBusy(event.id, true);
				processed = await this.itemHandler.processItem(page, event, pageIndex, clearPageCache);
				await this.database.item.updateBusy(event.id, false);
			}
			return processed;
		} catch (error) {
			let source: LogSource = LogSource.Unknown;
			if (event.type === UrlType.Account) {
				source = LogSource.Account;
				await this.database.account.updateFailed(event.id)
				await this.database.account.updateBusy(event.id, false);
			} else if (event.type === UrlType.Item) {
				source = LogSource.Item;
				await this.database.item.updateFailed(event.id)
				await this.database.item.updateBusy(event.id, false);
			}

			logger.error(
				error,
				logMessage(source, `[${pageIndex}] Processing failed: ${error.message}`, event.url)
			);

			return false;
		}
	}

	private async getInitialUrlsToProcess(
		type: UrlType,
	): Promise<string[]> {
		switch (type) {
			case UrlType.Account:
				return (await this.database.account.getNotProcessed()).map(({ url }) => url);
			// return ([(await this.database.account.getById(1)).url])
			// return (await this.database.account.getAccountRelated(1)).map(({ url }) => url).reverse()
			case UrlType.Item:
				return (await this.database.item.getNotProcessed()).map(({ url }) => url);
			// return (await this.database.item.getUserItems(1)).map(({ url }) => url)
			default:
				throw new Error('Scrapping Type is invalid!');
		}
	}

	private async enqueueFromDb(
		queue: ProcessingQueue,
		type: UrlType
	): Promise<void> {
		let urls: string[] = await this.getInitialUrlsToProcess(type);
		if (urls.length !== 0) {
			await queue.enqueueButch(urls);
		}
	}

	private async getBrowser(docker: boolean, headless: boolean): Promise<Browser> {
		if (docker) {
			return await puppeteer.connect({
				browserWSEndpoint: 'ws://localhost:3000',
			});
		} else {
			return await puppeteer.launch({
				headless: headless,
				devtools: false,
				ignoreDefaultArgs: [
					'--enable-automation'
				],
				args: [
					'--disable-accelerated-2d-canvas',
					'--no-zygote',
					'--disable-component-extensions-with-background-pages',
					'--disable-dev-shm-usage',
					'--disable-gpu',
					'--disable-setuid-sandbox',
					'--disable-stack-profiler',
					'--dns-server=1.1.1.1',
					'--ignore-certificate-errors',
					'--incognito',
					'--no-first-run',
					'--no-sandbox',
					'--no-zygote',
					'--performance',
					'--disable-infobars',
					//'--single-process',
				]
			} as PuppeteerLaunchOptions);
		}
	}

}
