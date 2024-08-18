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
		failed: 0
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
		this.database = await BandDatabase.initialize();
		await this.database.account.resetAllBusy();
		await this.database.item.resetAllBusy();

		// init queue
		const queue: ProcessingQueue = new ProcessingQueue(
			await this.getInitialUrlsToProcess(type, fromFile),
			this.database
		);

		const promises: Promise<void>[] = Array.from({ length: concurrencyBrowsers })
			.map(async (_, id: number) => {
				const browser = await this.getBrowser(docker, headless);
				const pages = await browser.pages();
				const page = isNullOrUndefined(pages) || pages.length === 0
					? await browser.newPage()
					: pages[0];

				await page.setRequestInterception(true);
				page.on('request', (request) => {
					if (['font', 'image', 'stylesheet', 'media'].includes(request.resourceType())) {
						request.abort();
					} else {
						request.continue();
					}
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
		// fill cluster
		while (true) {
			// fill queue
			if (queue.size === 0) {
				await this.enqueueFromDb(queue, type);
				if (queue.size === 0) {
					break;
				}
			}

			// do not make a call if changing of IP is in progress
			if (ProxyClient.initialize.isProcessing) {
				await delay();
				continue;
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

			if ((this.statistic.processed + this.statistic.failed) % 1_000 === 0) {
				logger.info(JSON.stringify(this.statistic));
			}
		}
	}

	private async processUrl(
		event: QueueEvent,
		page: Page,
		pageIndex: number
	): Promise<boolean> {
		try {
			switch (event.type) {
				case UrlType.Account:
					await this.database.account.updateBusy(event.id, true);
					await this.accountHandler.processAccount(page, event, pageIndex);
					await this.database.account.updateBusy(event.id, false);
					break;
				case UrlType.Item:
					await this.database.item.updateBusy(event.id, true);
					await this.itemHandler.processItem(page, event, pageIndex);
					await this.database.item.updateBusy(event.id, false);
					break;
			}
			return true;
		} catch (error) {
			let source: LogSource = LogSource.Unknown;
			switch (event.type) {
				case UrlType.Account:
					source = LogSource.Account;
					await this.database.account.updateFailed(event.id)
					await this.database.account.updateBusy(event.id, false);
					break;
				case UrlType.Item:
					source = LogSource.Item;
					await this.database.item.updateFailed(event.id)
					await this.database.item.updateBusy(event.id, false);
					break;
			}

			logger.error(
				error,
				logMessage(source, `[${pageIndex}}] Processing failed: ${error.message}`, event.url)
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
					: (await this.database.account.getNotProcessed()).map(({ url }) => url);
			case UrlType.Item:
				return fromFile
					? this.readUrlsFromFile('items.txt')
					: (await this.database.item.getNotProcessed()).map(({ url }) => url);
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
					'--no-sandbox',
					'--disable-setuid-sandbox',
					'--disable-dev-shm-usage',
					'--disable-accelerated-2d-canvas',
					'--no-first-run',
					'--no-zygote',
					'--single-process',
					'--disable-gpu',
					'--ignore-certificate-errors',
				]
			} as PuppeteerLaunchOptions);
		}
	}

}
