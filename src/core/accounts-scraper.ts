import { Page } from 'puppeteer';
import { BrowserOptions, performInBrowser } from '../common/browser';
import { logger } from '../common/logger';
import { Database } from '../data/db';
import { AccountEntity } from '../entities/account-entity';
import { AccountPageService } from './page-services/account-page-service';

export class AccountsScraper {
	public async run(browserOptions: BrowserOptions, pagesCount: number): Promise<void> {
		const database: Database = await Database.initialize();
		const accounts: AccountEntity[] = await database.getAllAccounts();

		const processedAccount: string[] = [];

		// scrap chunks
		await performInBrowser(
			this.pageFunctionWrapper(database, accounts, processedAccount),
			pagesCount,
			browserOptions
		);
	}

	private pageFunctionWrapper = (database: Database, accounts: AccountEntity[], processedAccount: string[]) => {
		return async (page: Page) => {
			const pageService = new AccountPageService();

			while (accounts.length > 0) {
				const account = accounts.pop();

				if (processedAccount.includes(account.url)) {
					continue;
				}

				try {
					// open account page
					await page.goto(account.url, { timeout: 10_000, waitUntil: 'networkidle0' });

					// scrap items
					await this.processAccount(page, pageService, database, account);

					// save as processed
					processedAccount.push(account.url);

					logger.info(`Processed count: [${processedAccount.length}]`);
				} catch (error) {
					accounts.push(account)
					logger.error(error);
				}
			}
		}
	}


	private async processAccount(
		page: Page,
		pageService: AccountPageService,
		database: Database,
		account: AccountEntity,
	): Promise<void> {
		const urls: string[] = await pageService.readAllPageAccounts(page);

		const result = urls.map(url => ({
			id: account.id,
			url
		}));

		//save tracks
		const urlId = await this.saveUrls(database, result);

		//save relations
		const itemsCount = await this.saveRelations(database, urlId, result);

		logger.debug({
			message: 'Account processing finished!',
			url: account.url,
			items: itemsCount,
		});
	}

	private async saveUrls(
		database: Database,
		accountUrls: { id: number, url: string }[]
	): Promise<{ [p: string]: number }> {
		const urlId: { [url: string]: number } = {};

		for (const { url } of accountUrls) {
			let { id } = await database.insertItem(url);
			if (id) {
				urlId[url] = id;
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



