import { Page } from 'puppeteer';
import { BrowserOptions, performInBrowser } from '../common/browser';
import { logger } from '../common/logger';
import { Database } from '../data/db';
import { AccountEntity } from '../entities/account-entity';
import { AccountPageService } from './page-services/account-page-service';

export class AccountsScraper {
	public async run(browserOptions: BrowserOptions, pagesCount: number): Promise<void> {
		const database = await Database.initialize();
		const accounts = (await database.getAllAccounts()).reverse();

		// scrap chunks
		await performInBrowser(
			this.pageFunctionWrapper(database, accounts),
			pagesCount,
			browserOptions
		);
	}

	private pageFunctionWrapper = (database: Database, accounts: AccountEntity[]) => {
		return async (page: Page) => {
			const pageService = new AccountPageService(page);

			while (accounts.length > 0) {
				const { id, url } = accounts.pop();

				// open account page
				await page.goto(url);

				const urls: string[] = await pageService.readAllPageAccounts();

				const result = urls.map(url => ({
					id,
					url
				}));

				//save tracks
				const urlId = await this.saveUrls(database, result);

				//save relations
				const relationsCount = await this.saveRelations(database, urlId, result);

				logger.success({
					message: 'Relations was saved successfully!',
					count: relationsCount,
					url,
				});
			}
		}
	}


	private async saveUrls(
		database: Database,
		accountUrls: { id: number, url: string }[]
	): Promise<{ [p: string]: number }> {
		const urlId: { [url: string]: number } = {};

		for (const { url } of accountUrls) {
			let albumId = await database.insertItem(url);
			if (albumId) {
				urlId[url] = albumId;
			}
		}

		return urlId;
	}

	private async saveRelations(
		database: Database,
		urlId: { [url: string]: number },
		accountUrls: { id: number, url: string }[]
	): Promise<number> {
		let relationsCount = 0;
		for (const element of accountUrls) {
			const { id, url } = element;
			const urlsId = urlId[url];

			const added = await database.insertItemToAccount(urlsId, id);
			if (added) {
				relationsCount++;
			}
		}
		return relationsCount;
	}
}



