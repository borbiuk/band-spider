import { Page } from 'puppeteer';
import { BrowserOptions, performInBrowser } from '../common/browser';
import { logger } from '../common/logger';
import { Database } from '../data/db';
import { readUrlsFromFile } from '../data/file';
import { AccountEntity } from '../entities/account-entity';
import { AccountPageService } from './page-services/account-page-service';

export class AccountsScraper {
	public async run(
		fromFile: boolean = true,
		browserOptions: BrowserOptions,
		pagesCount: number
	): Promise<void> {
		const database: Database = await Database.initialize();
		const accounts: AccountEntity[] = fromFile
			? readUrlsFromFile('accounts.txt').map(x => ({ url: x } as AccountEntity))
			: await database.getAllAccounts();

		const processedAccount: string[] = [];

		// scrap chunks
		await performInBrowser(
			this.pageFunctionWrapper(database, accounts, processedAccount),
			Math.min(pagesCount, accounts.length),
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
					await this.processAccount(page, pageService, database, account);
					processedAccount.push(account.url);
					logger.info(`Processed count: [${processedAccount.length}]`);
				} catch (error) {
					accounts.push(account)
					logger.error(error, account.url);
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
		// open url and show all accounts
		await page.goto(account.url, { timeout: 10_000, waitUntil: 'networkidle0' });

		// save Account
		const { id } = await database.insertAccount(account.url);

		const itemsUrls: string[] = await pageService.readAllAccountItems(page);

		const result = itemsUrls.map(url => ({
			id,
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



