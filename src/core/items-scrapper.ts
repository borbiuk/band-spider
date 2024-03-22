import puppeteer from 'puppeteer';
import { delay } from '../common/utils';
import { Database } from '../data/db';
import { readUrlsFromFile } from '../data/file';
import { ItemEntity } from '../entities/item-entity';
import { UrlScrapResult } from '../models/url-scrap-result';
import { ItemPageService } from './page-services/item-page-service';

export class ItemsScrapper {
	private readonly PAGES_COUNT: number = 5;
	private readonly OPEN_URL_DELAY: number = 3_000;

	private browser;
	private database: Database;
	private items: ItemEntity[];

	public async run(fromFile: boolean = true, headless: boolean = false): Promise<void> {
		this.browser = await puppeteer.launch({ headless });
		this.database = await Database.initialize();

		// read URLs
		this.items = fromFile
			? readUrlsFromFile('source.txt').map(x => ({ url: x } as ItemEntity))
			: await this.database.getAllItems();

		// process chunks
		await this.scrapChunks();

		// close browser
		await this.browser.close();
	}

	private async scrapChunks(): Promise<void> {
		// create parallel tasks

		const pagesPromises = Array.from({ length: this.PAGES_COUNT })
			.map(async () => {
				try {
					return await this.scrapChunk();
				} catch (e) {
					return [];
				}
			});

		await Promise.all(pagesPromises);
	}

	private async scrapChunk(): Promise<UrlScrapResult[]> {
		const results: UrlScrapResult[] = [];

		// open new page
		const page = await this.browser.newPage();
		const pageService = new ItemPageService(page);

		while (this.items.length > 0) {
			const item = this.items.pop();

			// open url and show all accounts
			await page.goto(item.url);
			await delay(this.OPEN_URL_DELAY);

			// scrap accounts
			const accountUrls = await pageService.readAllPageAccounts(page)

			const result = {
				url: item.url,
				urls: accountUrls,
			}

			//save urls
			const urlId = await this.saveUrls(result);

			//save accounts
			const accountId = await this.saveAccounts(result);

			//save relations
			const relationsCount = await this.saveRelations(result, urlId, accountId);
		}

		await page.close();

		return results;
	}

	private async saveRelations(
		res: UrlScrapResult,
		urlId: { [url: string]: number },
		accountId: { [url: string]: number }
	): Promise<number> {
		let relationsCount = 0;

		const { url, urls } = res;

		const id = urlId[url];
		for (const element of urls) {
			const accId = accountId[element];
			const added = await this.database.insertItemToAccount(id, accId);
			if (added) {
				relationsCount++;
			}
		}

		return relationsCount;
	}

	private async saveAccounts(
		res: UrlScrapResult
	): Promise<{ [p: string]: number }> {
		const accountId: { [url: string]: number } = {};

		for (let b of res.urls) {
			const id = await this.database.insertAccount(b);
			if (id) {
				accountId[b] = id;
			}
		}

		return accountId;
	}

	private async saveUrls(
		res: UrlScrapResult
	): Promise<{ [p: string]: number }> {
		const urlId: { [url: string]: number } = {};

		const id = await this.database.insertItem(res.url)
		if (id) {
			urlId[res.url] = id;
		}

		return urlId;
	}
}
