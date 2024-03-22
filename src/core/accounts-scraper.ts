import puppeteer from 'puppeteer';
import { Database } from '../data/db';
import { AccountEntity } from '../entities/account-entity';
import { AccountScrapResult } from '../models/url-scrap-result';
import { AccountPageService } from './page-services/account-page-service';

export class AccountsScraper {
	private readonly PAGES_COUNT: number = 5;

	private browser;
	private database: Database;
	private accounts: AccountEntity[];

	public async run(): Promise<void> {
		this.browser = await puppeteer.launch({ headless: false });
		this.database = await Database.initialize();

		// read URLs
		this.accounts = await this.database.getAllAccounts();

		// scrap chunks
		await this.scrapChunks();

		this.browser.close();
	}

	private async scrapChunks(): Promise<void> {

		// create parallel tasks
		const promises = Array.from({ length: this.PAGES_COUNT })
			.map(async () => {
				try {
					return await this.scrapChunk()
				} catch (e) {
					return []
				}
			});

		// wait all tasks
		await Promise.all(promises)
	}

	private async scrapChunk(): Promise<AccountScrapResult[]> {
		const chunkResult: AccountScrapResult[] = [];

		const page = await this.browser.newPage();
		const pageService = new AccountPageService(page);
		
		while (this.accounts.length > 0) {
			const { id, url } = this.accounts.pop();

			// open account page
			await page.goto(url);

			const urls: string[] = await pageService.readAllPageAccounts();

			const result = urls.map(url => ({
				id,
				url
			}));

			//save tracks
			const urlId = await this.saveUrls(result);

			//save relations
			const relationsCount = await this.saveRelations(urlId, result);
		}

		await page.close();

		return chunkResult;
	}

	private async saveUrls(
		accountUrls: { id: number, url: string }[]
	): Promise<{ [p: string]: number }> {
		const urlId: { [url: string]: number } = {};

		for (const { url } of accountUrls) {
			let albumId = await this.database.insertItem(url);
			if (albumId) {
				urlId[url] = albumId;
			}
		}

		return urlId;
	}

	private async saveRelations(
		urlId: { [url: string]: number },
		accountUrls: { id: number, url: string }[]
	): Promise<number> {
		let relationsCount = 0;
		for (const element of accountUrls) {
			const { id, url } = element;
			const urlsId = urlId[url];

			const added = await this.database.insertItemToAccount(urlsId, id);
			if (added) {
				relationsCount++;
			}
		}
		return relationsCount;
	}
}



