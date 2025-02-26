import dns from 'dns/promises';
import { Browser, HTTPResponse, LaunchOptions, Page } from 'puppeteer';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { errorColor, logger, LogSource, speedColor, successColor } from '../common/logger';
import { ProcessingQueue, QueueEvent } from '../common/processing-queue';
import { delay, isNullOrUndefined, logMessage } from '../common/utils';
import { BandDatabase } from '../data/db';
import { BandSpiderOptions } from '../index';
import { processAccount } from './account/account-handler';
import { processItem } from './item/item-handler';
import { ProxyClient } from './proxy/proxy-client';

export enum UrlType {
	Account = 'account',
	Item = 'item',
}

export class BandSpider {
	private readonly statistic = {
		processed: 0,
		skipped: 0,
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
		logger.debug('DB synchronizing...')
		this.database = await BandDatabase.initialize();
		logger.debug('DB synchronized!');

		logger.debug('DB preparing ...');
		await this.database.account.resetAllBusy();
		await this.database.item.resetAllBusy();
		logger.debug('DB ready!');

		// init queue
		logger.debug('Queue init...');
		const queue: ProcessingQueue = new ProcessingQueue(
			await this.getInitialUrlsToProcess(type),
			this.database
		);
		logger.debug('Queue ready!');

		// change IP
		await ProxyClient.initialize.changeIp(true);

		// configure browsers closing on exit
		const browsersList: { [id: number]: Browser } = {};
		process.on('SIGINT', () => {
			Object.values(browsersList).forEach(x => (x.close()));
			logger.warn('Browsers closed');
		});

		const recreateBrowser = async (id: number, safe = true): Promise<Page> => {
			try {
				const existed = browsersList[id];
				if (!isNullOrUndefined(existed)) {
					await existed.close();
					logger.debug(
						logMessage(LogSource.Browser, `[${String(id).padEnd(2)}] closed!`)
					);
				}

				const browser = await this.getBrowser(docker, headless);
				browsersList[id] = browser;

				logger.debug(
					logMessage(LogSource.Browser, `[${String(id).padEnd(2)}] created!`)
				);
				return await this.getPage(browser, headless);
			}
			catch (e) {
				if (!safe) {
					logger.error(e)
					throw e;
				}

				return await recreateBrowser(id, false);
			}

		}

		// create jobs
		logger.debug(`${concurrencyBrowsers} Jobs (Browsers) init starting...`);
		const promises: Promise<void>[] = Array.from({ length: concurrencyBrowsers })
			.map(async (_, id: number) => {
				return this.startPageProcessing(
					recreateBrowser,
					queue,
					type,
					id,
				);
			});
		logger.debug('Jobs started!');

		// run jobs
		await Promise.all(promises)
	}

	private async startPageProcessing(
		recreateBrowser: (id: number) => Promise<Page>,
		queue: ProcessingQueue,
		type: UrlType,
		id: number,
	) {
		if (isNullOrUndefined(this.statistic.start)) {
			this.statistic.start = new Date().getTime()
		}

		let page = await recreateBrowser(id);

		let i = 0;
		while (true) {
			i++;

			// do not make a call if changing of IP is in progress
			if (ProxyClient.initialize.isProcessing) {
				await delay(2_000);
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

				// if (this.statistic.processed * 1.5 < this.statistic.failed) {
				// 	await page.browser().close();
				// 	throw 'No sense to process!';
				// }
			}

			if (i % 50 === 0) {
				page = await recreateBrowser(id);
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
	): Promise<boolean> {
		try {
			let processed = false;
			if (event.type === UrlType.Account) {
				await this.database.account.updateBusy(event.id, true);
				processed = await processAccount(event, this.database, page, pageIndex);
				if (!processed) {
					await this.database.account.updateFailed(event.id)
				}
				await this.database.account.updateBusy(event.id, false);
			} else if (event.type === UrlType.Item) {
				await this.database.item.updateBusy(event.id, true);
				processed = await processItem(event, this.database, page, pageIndex);
				if (!processed) {
					await this.database.item.updateFailed(event.id)
				}
				await this.database.item.updateBusy(event.id, false);
			}
			return processed;
		} catch (error) {
			console.log('\n\n\n\n\n\n\n\nTHIS SHOULD NOT BE HERE !!!!\n\n\n\n\n\n\n\n\n\n\n\n\n\n')
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

			if (error.message === 'Page did not exist') {
				logger.warn(
					logMessage(source, `[${String(pageIndex).padStart(2)}] Page did not exist`.padEnd(50), event.url)
				);
				return true;
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
					'--disable-background-timer-throttling',
					'--disable-backgrounding-occluded-windows',
					'--disable-breakpad',
					'--disable-client-side-phishing-detection',
					'--disable-component-extensions-with-background-pages',
					'--disable-default-apps',
					'--disable-dev-shm-usage',
					'--disable-extensions',
					'--disable-gpu',
					'--disable-infobars',
					'--disable-popup-blocking',
					'--disable-setuid-sandbox',
					'--dns-server=1.1.1.1',
					'--ignore-certificate-errors',
					'--incognito',
					'--no-first-run',
					'--no-sandbox',
					'--no-zygote',
					'--performance',
					'--window-size=1200,800',
					//'--single-process',
				]
			} as LaunchOptions);
		}
	}

	private async getPage(
		browser: Browser,
		headless: boolean,
	): Promise<Page> {
		const pages = await browser.pages();
		const page = isNullOrUndefined(pages) || pages.length === 0
			? await browser.newPage()
			: pages[0];

		// response handling
		page.on('response', async (httpResponse: HTTPResponse) => {
			if (httpResponse.status() !== 429) {
				return;
			}

			try {
				const url = new URL(httpResponse.url());
				const { address } = await dns.lookup(url.hostname);
				console.log('IP:' + address);

				await ProxyClient.initialize.changeIp();
			} catch (e) {
				logger.error(e, logMessage(LogSource.Browser, 'IP error', httpResponse.url()))
			}
		});

		// request filtering
		if (headless) {
			await page.setCacheEnabled(false);

			await page.setRequestInterception(true);
			page.on('request', (request) => {
				if ([
					'font',
					'image',
					'media'
				].includes(request.resourceType())) {
					request.abort();
					return;
				}

				const url = request.url();
				if (request.method() === 'POST' && url !== 'https://bandcamp.com/api/fancollection/1/collection_items') {
					request.abort();
					return;
				}

				if (
					url.includes('recaptcha')
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
		}

		return page;
	}

}
