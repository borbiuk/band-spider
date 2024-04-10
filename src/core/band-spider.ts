import { Page } from 'puppeteer';
import { performInBrowser } from '../common/browser';
import { logger, Source } from '../common/logger';
import { Queue } from '../common/queue';
import { isNullOrUndefined, isTrackOrAlbum, isValidUrl, logMessage, waitOn } from '../common/utils';
import { Database } from '../data/db';
import { readUrlsFromFile } from '../data/file';
import { AccountHandler } from './processors/account-handler';
import { ItemHandler } from './processors/item-handler';

export enum InitType {
	Account = 'account',
	Item = 'item',
}

export class BandSpider {
	private database: Database;

	public async run(
		pagesCount: number,
		headless: boolean,
		type: InitType,
		fromFile: boolean,
	): Promise<void> {
		this.database = await Database.initialize();

		const errors: { [url: string]: number } = {};
		const queue: Queue = new Queue(
			await this.getInitialUrlsToProcess(type, fromFile)
		);

		// scrap chunks
		await performInBrowser(
			this.pageFunctionWrapper(queue, errors, type),
			pagesCount,
			{ headless }
		);
	}

	private async getInitialUrlsToProcess(
		type: InitType,
		fromFile: boolean,
	): Promise<string[]> {
		const database = await Database.initialize();
		switch (type) {
			case InitType.Account:
				return fromFile
					? readUrlsFromFile('accounts.txt')
					: (await database.getNotProcessedAccounts()).map(({ url }) => url);
			case InitType.Item:
				return fromFile
					? readUrlsFromFile('items.txt')
					: (await database.getNotProcessedItems()).map(({ url }) => url);
			default:
				throw new Error('Scrapping Type is invalid!');
		}
	}

	private pageFunctionWrapper = (
		queue: Queue,
		errors: { [url: string]: number; },
		type: InitType,
	) => {
		return async (page: Page): Promise<void> => {

			// create handlers
			const accountHandler = new AccountHandler();
			const itemHandler = new ItemHandler();

			// process while exists
			while (true) {
				if (!await waitOn(() => queue.size > 0, 60_000 * 5)) {
					queue.enqueueButch(
						(type === InitType.Account
							? await this.database.getNotProcessedAccounts()
							: await this.database.getNotProcessedItems()).map(({ url }) => url)
					);

					if (queue.size === 0) {
						break;
					}
				}

				const url: string = queue.dequeue();

				// continue if already processed
				const isAlreadyProcessed: boolean = await this.isAlreadyProcessed(url);
				if (isAlreadyProcessed) {
					continue;
				}

				// process
				const extractedUrls: string[] = await this.processUrl(
					page,
					itemHandler,
					accountHandler,
					url,
					errors
				);

				// add extracted urls to process
				extractedUrls
					.filter(async x => !await this.isAlreadyProcessed(x))
					.forEach(x => {
							queue.enqueue(x);
						}
					);
			}
		}
	}

	private async isAlreadyProcessed(
		url: string,
	): Promise<boolean> {
		const database: Database = await Database.initialize();
		return isTrackOrAlbum(url)
			? await database.isItemAlreadyProcessed(url)
			: await database.isAccountAlreadyProcessed(url);
	}

	private async processUrl(
		page: Page,
		itemHandler: ItemHandler,
		accountHandler: AccountHandler,
		url: string,
		errors: { [p: string]: number }
	): Promise<string[]> {
		const extractedUrls: string[] = [];

		const isItem = isTrackOrAlbum(url);
		try {
			if (isItem) {
				const itemAccountsUrls = await itemHandler.processItem(page, url);
				for (const accountUrl of itemAccountsUrls) {
					extractedUrls.push(accountUrl);
				}
			} else if (isValidUrl(url)) {
				const accountItemsUrls = await accountHandler.processAccount(page, url);
				for (const itemUrl of accountItemsUrls) {
					extractedUrls.push(itemUrl);
				}
			}
		} catch (error) {
			logger.error(
				error,
				logMessage(
					isItem ? Source.Item : Source.Account,
					`Processing failed: ${error.message}`,
					url
				)
			);

			// increase url errors count
			if (isNullOrUndefined(errors[url])) {
				errors[url] = 1;
			} else {
				errors[url] += 1;
			}

			if (errors[url] < 3) {
				extractedUrls.push(url);
			} else {
				logger.fatal(
					error,
					logMessage(
						isItem ? Source.Item : Source.Account,
						`Cant be processed after retry: ${error.message}`,
						url
					)
				);
			}
		}

		return extractedUrls;
	}
}
