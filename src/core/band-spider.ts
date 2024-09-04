import * as fs from 'node:fs';
import { Browser, HTTPResponse, Page, PuppeteerLaunchOptions } from 'puppeteer';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { logger, LogSource } from '../common/logger';
import { ProcessingQueue, QueueEvent } from '../common/processing-queue';
import { delay, isNullOrUndefined, logMessage } from '../common/utils';
import { BandDatabase } from '../data/db';
import { BandSpiderOptions } from '../index';
import { AccountHandler } from './processors/account-handler';
import { ItemHandler } from './processors/item-handler';
import { ProxyClient } from './proxy/proxy-client';

export enum UrlType {
	Account = 'account',
	Item = 'item',
}

export class BandSpider {
	private readonly accountHandler: AccountHandler = new AccountHandler();
	private readonly itemHandler: ItemHandler = new ItemHandler();
	private readonly statistic = {
		processed: 0,
		failed: 0,
		start: new Date().getTime()
	};

	private database: BandDatabase;

	public async run(
		{
			concurrencyBrowsers,
			headless,
			type,
			fromFile,
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
			await this.getInitialUrlsToProcess(type, fromFile),
			this.database
		);
		logger.info('Queue ready!');

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
				page.on('response', (httpResponse: HTTPResponse) => {
					if (httpResponse.status() === 429) {
						ProxyClient.initialize.changeIp();
					}
				});

				return this.processPage(
					page,
					queue,
					type,
					id
				);
			});
		await Promise.all(promises)
	}

	private async processPage(
		page: Page,
		queue: ProcessingQueue,
		type: UrlType,
		id: number,
	) {
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
						`Processed: ${this.statistic.processed}; Failed: ${this.statistic.failed}; Speed: ${this.statistic.processed / ((new Date().getTime() - this.statistic.start) / 1000)}`
					)
				);

				if (this.statistic.processed < this.statistic.failed) {
					await page.browser().close();
					throw 'No sense to process!';
				}
			}
		}
	}

	private async processUrl(
		event: QueueEvent,
		page: Page,
		pageIndex: number
	): Promise<boolean> {
		try {
			let processed = false;
			if (event.type === UrlType.Account) {
				await this.database.account.updateBusy(event.id, true);
				processed = await this.accountHandler.processAccount(page, event, pageIndex);
				await this.database.account.updateBusy(event.id, false);
			} else if (event.type === UrlType.Item) {
				await this.database.item.updateBusy(event.id, true);
				processed = await this.itemHandler.processItem(page, event, pageIndex);
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
		fromFile: boolean,
	): Promise<string[]> {
		switch (type) {
			case UrlType.Account:
				return fromFile
					? this.readUrlsFromFile('accounts.txt')
					: //([(await this.database.account.getById(1)).url])
					//(await this.database.account.getAccountRelated(1)).map(({ url }) => url).reverse()
					(await this.database.account.getNotProcessed()).map(({ url }) => url);
			case UrlType.Item:
				return fromFile
					? this.readUrlsFromFile('items.txt')
					: //(await this.database.item.getUserItems(1)).map(({ url }) => url)
					(await this.database.item.getNotProcessed()).map(({ url }) => url);
			default:
				throw new Error('Scrapping Type is invalid!');
		}
	}

	private async enqueueFromDb(
		queue: ProcessingQueue,
		type: UrlType
	): Promise<void> {
		let urls: string[] = await this.getInitialUrlsToProcess(type, false);
		if (urls.length !== 0) {
			await queue.enqueueButch(urls);
		}
	}

	// Returns URLs from file
	private readUrlsFromFile = (fileName: string): string[] => {
		const fileContent: string = fs.readFileSync(fileName, 'utf8');
		return fileContent.split('\n');
	};

	private async getBrowser(docker: boolean, headless: boolean): Promise<Browser> {
		if (docker) {
			return await puppeteer.connect({
				browserWSEndpoint: 'ws://localhost:3000',
			});
		} else {
			return await puppeteer.launch({
				headless: headless,
				devtools: false,
				args: [
					'--disable-accelerated-2d-canvas',
					'--disable-dev-shm-usage',
					'--disable-gpu',
					'--disable-setuid-sandbox',
					'--disable-stack-profiler',
					'--dns-server=1.1.1.1',
					'--ignore-certificate-errors',
					'--no-first-run',
					'--no-sandbox',
					'--no-zygote',
					'--single-process',
					'--performance',
					'--disable-component-extensions-with-background-pages'
				]
			} as PuppeteerLaunchOptions);
		}
	}

}
