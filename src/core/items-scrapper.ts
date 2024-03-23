import { Page } from 'puppeteer';
import { BrowserOptions, performInBrowser } from '../common/browser';
import { logger } from '../common/logger';
import { delay } from '../common/utils';
import { Database } from '../data/db';
import { readUrlsFromFile } from '../data/file';
import { ItemEntity } from '../entities/item-entity';
import { UrlScrapResult } from '../models/url-scrap-result';
import { ItemPageService } from './page-services/item-page-service';

export class ItemsScrapper {
	private readonly OPEN_URL_DELAY: number = 1_500;

	public async run(fromFile: boolean = true, browserOptions: BrowserOptions, pagesCount: number): Promise<void> {
		const database = await Database.initialize();

		// read URLs
		const items = fromFile
			? readUrlsFromFile('source.txt').map(x => ({ url: x } as ItemEntity))
			: await database.getAllItems();

		// process chunks
		await performInBrowser(
			this.pageFunctionWrapper(database, items),
			pagesCount,
			browserOptions
		);
	}

	private pageFunctionWrapper(database: Database, items: ItemEntity[]) {
		return async (page: Page) => {
			const pageService = new ItemPageService(page);

			while (items.length > 0) {
				const item = items.pop();

				// open url and show all accounts
				await page.goto(item.url);
				await delay(this.OPEN_URL_DELAY);

				// scrap accounts
				const accountUrls = await pageService.readAllPageAccounts(page)

				const result = {
					url: item.url,
					urls: accountUrls,
				};

				//save urls
				const urlId = await this.saveUrls(database, result);

				//save accounts
				const accountId = await this.saveAccounts(database, result);

				//save relations
				const relationsCount = await this.saveRelations(database, result, urlId, accountId);

				logger.success({
					message: 'Relations was saved successfully!',
					count: relationsCount,
					url: item.url,
				});
			}
		};
	}

	private async saveRelations(
		database: Database,
		res: UrlScrapResult,
		urlId: { [url: string]: number },
		accountId: { [url: string]: number }
	): Promise<number> {
		let relationsCount = 0;

		const { url, urls } = res;

		const id = urlId[url];
		for (const element of urls) {
			const accId = accountId[element];
			const added = await database.insertItemToAccount(id, accId);
			if (added) {
				relationsCount++;
			}
		}

		return relationsCount;
	}

	private async saveAccounts(
		database: Database,
		res: UrlScrapResult
	): Promise<{ [p: string]: number }> {
		const accountId: { [url: string]: number } = {};

		for (let accountUrl of res.urls) {
			const id = await database.insertAccount(accountUrl);
			if (id) {
				accountId[accountUrl] = id;
			}
		}

		return accountId;
	}

	private async saveUrls(
		database: Database,
		res: UrlScrapResult
	): Promise<{ [p: string]: number }> {
		const urlId: { [url: string]: number } = {};

		const id = await database.insertItem(res.url)
		if (id) {
			urlId[res.url] = id;
		}

		return urlId;
	}
}
