import * as fs from 'node:fs';
import { Page, ResourceType } from 'puppeteer';
import { logger, LogSource } from '../common/logger';
import { ProcessingQueue, QueueEvent } from '../common/processing-queue';
import { isNullOrUndefined, logMessage } from '../common/utils';
import { BandDatabase } from '../data/db';
import { AccountHandler } from './processors/account-handler';
import { ItemHandler } from './processors/item-handler';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
// import ProxyPlugin from 'puppeteer-extra-plugin-proxy'
import AnonymizeUAPlugin from 'puppeteer-extra-plugin-anonymize-ua';
import BlockResourcesPlugin from 'puppeteer-extra-plugin-block-resources';

export enum UrlType {
	Account = 'account',
	Item = 'item',
}

export class BandSpider {
	private readonly accountHandler: AccountHandler = new AccountHandler();
	private readonly itemHandler: ItemHandler = new ItemHandler();

	private database: BandDatabase;

	public async run(
		pagesCount: number,
		headless: boolean,
		type: UrlType,
		fromFile: boolean,
	): Promise<void> {
		// init database
		this.database = await BandDatabase.initialize();
		await this.database.account.resetAllBusy();
		await this.database.item.resetAllBusy();

		// init queue
		const queue: ProcessingQueue = new ProcessingQueue(
			await this.getInitialUrlsToProcess(type, fromFile),
			this.database
		);

		puppeteer.use(StealthPlugin());
		// puppeteer.use(ProxyPlugin()); need to add a proxy
		puppeteer.use(AnonymizeUAPlugin());
		puppeteer.use(BlockResourcesPlugin({
			blockedTypes: new Set<ResourceType>(['image', 'media', 'stylesheet', 'font', 'document'])
		}));

		const promises: Promise<void>[] = Array.from({length: pagesCount})
			.map(async (_, id: number) => {
				const browser = await puppeteer.launch({
					headless: headless
				});
				const pages = await browser.pages();
				const page = isNullOrUndefined(pages) || pages.length === 0
					? await browser.newPage()
					: pages[0];
				
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

			// dequeue and process
			const event: QueueEvent = await queue.dequeue();
			if (!isNullOrUndefined(event)) {
				await this.processUrl(
					event,
					page,
					id,
				);
			}
		}
	}

	private async processUrl(
		event: QueueEvent,
		page: Page,
		pageIndex: number
	): Promise<void> {
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
		}
	}

	private async getInitialUrlsToProcess(
		type: UrlType,
		fromFile: boolean,
	): Promise<string[]> {
		const database: BandDatabase = await BandDatabase.initialize();
		switch (type) {
			case UrlType.Account:
				return fromFile
					? this.readUrlsFromFile('accounts.txt')
					: (await database.account.getNotProcessed()).map(({ url }) => url);
			case UrlType.Item:
				return fromFile
					? this.readUrlsFromFile('items.txt')
					: (await database.item.getNotProcessed()).map(({ url }) => url);
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

}
