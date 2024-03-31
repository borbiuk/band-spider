import { Page } from 'puppeteer';
import { performInBrowser } from '../common/browser';
import { logger } from '../common/logger';
import { isAlbum, isTrack, isValidUrl, waitOn } from '../common/utils';
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

		const urls: string[] = await this.getInitialUrlsToProcess(type, fromFile, database);
		const processedUrls = new Set<string>();

		// scrap chunks
		await performInBrowser(
			this.pageFunctionWrapper(database, urls, processedUrls),
			pagesCount,
			{ headless }
		);
	}

	private async getInitialUrlsToProcess(
		type: InitType,
		fromFile: boolean,
		database: Database
	): Promise<string[]> {
		if (type === InitType.Account) {
			return fromFile
				? readUrlsFromFile('accounts.txt')
				: (await database.getAllAccounts()).map(({url}) => url);
		}

		if (type === InitType.Item) {
			return fromFile
				? readUrlsFromFile('items.txt')
				: (await database.getAllItems()).map(({url}) => url);
		}
		
		throw new Error('Scrapping Type is invalid!');
	}

	private pageFunctionWrapper = (database: Database, urls: string[], processedUrls: Set<string>) => {
		return async (page: Page) => {

			// create page services
			const accountPageService = new AccountPageService();
			const itemPageService = new ItemPageService();

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

				try {
					if (isTrack(url) || isAlbum(url)) {
						const itemAccountsUrls = await itemHandler.processItem(page, itemPageService, database, url);
						for (const accountUrl of itemAccountsUrls) {
							urls.push(accountUrl);
						}
					}
					else if (isValidUrl(url)) {
						const accountItemsUrls = await accountHandler.processAccount(page, accountPageService, database, url);
						for (const itemUrl of accountItemsUrls) {
							urls.push(itemUrl);
						}
					}

					processedUrls.add(url);
				}
				catch (error) {
					logger.error(error, url);
					urls.push(url);
				}
			}
		}
	}
}
