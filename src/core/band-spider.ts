import * as fs from 'node:fs';
import { Page } from 'puppeteer';
import { BrowserOptions, performInBrowser } from '../common/browser';
import { logger, LogSource } from '../common/logger';
import { ProcessingQueue, QueueEvent } from '../common/processing-queue';
import { isNullOrUndefined, logMessage, onlyUnique, waitOn } from '../common/utils';
import { BandDatabase } from '../data/db';
import { AccountHandler } from './processors/account-handler';
import { ItemHandler } from './processors/item-handler';

export enum UrlType {
	Account = 'account',
	Item = 'item',
}

export class BandSpider {
	private database: BandDatabase;

	public async run(
		pagesCount: number,
		headless: boolean,
		type: UrlType,
		fromFile: boolean,
	): Promise<void> {
		// init database
		this.database = await BandDatabase.initialize();
		await this.database.account.clearAllBusy();
		await this.database.item.clearAllBusy();

		// init queue
		const queue: ProcessingQueue = new ProcessingQueue(
			await this.getInitialUrlsToProcess(type, fromFile),
			this.database
		);

		// scrap items
		await performInBrowser(
			this.getPageHandler(queue, type),
			pagesCount,
			{ headless } as BrowserOptions
		);
	}

	private getPageHandler = (
		queue: ProcessingQueue,
		type: UrlType,
	) => {
		return async (page: Page): Promise<void> => {

			// create handlers
			const accountHandler = new AccountHandler(page);
			const itemHandler = new ItemHandler(page);

			// process while exists
			while (true) {
				if (!await waitOn(() => queue.size > 0, 60_000 * 5)) {
					await this.enqueueFromDb(queue, type);

					if (queue.size === 0) {
						break;
					}
				}

				const event: QueueEvent = await queue.dequeue();
				if (isNullOrUndefined(event)) {
					continue;
				}

				// process
				await this.processUrl(
					event,
					accountHandler,
					itemHandler,
				);
			}
		}
	}

	private async processUrl(
		event: QueueEvent,
		accountHandler: AccountHandler,
		itemHandler: ItemHandler,
	): Promise<void> {
		try {
			switch (event.type) {
				case UrlType.Account:
					await this.database.account.updateBusy(event.id, true);
					await accountHandler.processAccount(event);
					await this.database.account.updateBusy(event.id, false);
					break;
				case UrlType.Item:
					await this.database.item.updateBusy(event.id, true);
					await itemHandler.processItem(event);
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
				logMessage(source, `Processing failed: ${error.message}`, event.url)
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
