import * as fs from 'node:fs';
import { Page, PuppeteerNodeLaunchOptions } from 'puppeteer';
import { Cluster } from 'puppeteer-cluster';
import { logger, LogSource } from '../common/logger';
import { ProcessingQueue, QueueEvent } from '../common/processing-queue';
import { delay, isNullOrUndefined, logMessage } from '../common/utils';
import { BandDatabase } from '../data/db';
import { AccountHandler } from './processors/account-handler';
import { ItemHandler } from './processors/item-handler';

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

		// create parallel runner
		const cluster: Cluster<QueueEvent, void> = await Cluster.launch({
			concurrency: Cluster.CONCURRENCY_CONTEXT,
			maxConcurrency: pagesCount,
			puppeteerOptions: { headless, args: ['--no-sandbox'] } as PuppeteerNodeLaunchOptions,
			monitor: true
		});

		let count = 0;

		await cluster.task(async ({ page, data: event, worker: { id } }) => {

			// create handlers

			// process
			await this.processUrl(
				event,
				page,
				id,
			);
			count--;
		});

		await cluster.idle();

		// fill cluster
		while (true) {
			if (count > pagesCount * 2) {
				await delay();
				continue;
			}

			if (queue.size < pagesCount * 2) {
				await this.enqueueFromDb(queue, type);
				if (queue.size === 0) {
					break;
				}
			}

			const event: QueueEvent = await queue.dequeue();
			if (!isNullOrUndefined(event)) {
				await cluster.queue(event);
				count++;
			}
		}

		await cluster.close();
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
