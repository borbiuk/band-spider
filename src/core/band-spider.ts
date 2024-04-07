import { Page } from 'puppeteer';
import { performInBrowser } from '../common/browser';
import { logger, Source } from '../common/logger';
import { isNullOrUndefined, isTrackOrAlbum, isValidUrl, logMessage, waitOn } from '../common/utils';
import { Database } from '../data/db';
import { readUrlsFromFile } from '../data/file';
import { AccountPageService } from './page-services/account-page-service';
import { ItemPageService } from './page-services/item-page-service';
import { AccountHandler } from './processors/account-handler';
import { ItemHandler } from './processors/item-handler';

export enum InitType {
	Account = 'account',
	Item = 'item',
}

export class BandSpider {

	public async run(
		pagesCount: number,
		headless: boolean,
		type: InitType,
		fromFile: boolean,
	): Promise<void> {
		const database: Database = await Database.initialize();

		const urls: string[] = (await this.getInitialUrlsToProcess(type, fromFile, database));
		const processedUrls: Set<string> = new Set<string>();
		const errors: { [url: string]: number } = {};

		// scrap chunks
		await performInBrowser(
			this.pageFunctionWrapper(database, urls, processedUrls, errors),
			pagesCount,
			{ headless }
		);
	}

	private async getInitialUrlsToProcess(
		type: InitType,
		fromFile: boolean,
		database: Database
	): Promise<string[]> {
		switch (type) {
			case InitType.Account:
				return fromFile
					? readUrlsFromFile('accounts.txt')
					: (await database.getAllAccounts()).map(({ url }) => url);
			case InitType.Item:
				return fromFile
					? readUrlsFromFile('items.txt')
					: (await database.getAllItems()).map(({ url }) => url).reverse();
			default:
				throw new Error('Scrapping Type is invalid!');
		}
	}

	private pageFunctionWrapper = (
		database: Database,
		urls: string[],
		processedUrls: Set<string>,
		errors: { [url: string]: number; }
	) => {
		return async (page: Page): Promise<void> => {

			// create handlers
			const accountHandler = new AccountHandler();
			const itemHandler = new ItemHandler();

			// process while exists
			while (true) {
				if (urls.length === 0 && !await waitOn(() => urls.length > 0, 60_000 * 5)) {
					break;
				}

				const url = urls.pop();

				if (processedUrls.has(url)) {
					continue;
				}

				const extractedUrls: string[] = await this.processUrl(
					page,
					itemHandler,
					accountHandler,
					database,
					url,
					errors
				);
				extractedUrls.forEach(x => {
					urls.push(x);
				});
			}
		}
	}

	private async processUrl(
		page: Page,
		itemHandler: ItemHandler,
		accountHandler: AccountHandler,
		database: Database,
		url: string,
		errors: { [p: string]: number }
	): Promise<string[]> {
		const extractedUrls: string[] = [];

		const isItem = isTrackOrAlbum(url);
		try {
			if (isItem) {
				//TODO: remove it
				return [];
				const itemAccountsUrls = await itemHandler.processItem(page, database, url);
				for (const accountUrl of itemAccountsUrls) {
					extractedUrls.push(accountUrl);
				}
			} else if (isValidUrl(url)) {
				const accountItemsUrls = await accountHandler.processAccount(page, database, url);
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
