import { Page } from 'puppeteer';
import { logger, Source } from '../../common/logger';
import { logMessage } from '../../common/utils';
import { Database } from '../../data/db';
import { AccountPageService } from '../page-services/account-page-service';

export class AccountHandler {
	private readonly pageService: AccountPageService = new AccountPageService();

	public async processAccount(
		page: Page,
		database: Database,
		accountUrl: string
	): Promise<string[]> {
		const urls: string[] = [];

		// open url and show all accounts
		await page.goto(accountUrl, { timeout: 15_000, waitUntil: 'domcontentloaded' });

		// save Account
		const { id } = await database.insertAccount(accountUrl);

		// scrap and save Items
		const processingResult = await this.readAndSaveAccountItems(page, this.pageService, database, id, urls);

		// save that account was processed now
		await database.updateAccountProcessingDate(id);

		logger.info(
			logMessage(
				Source.Account,
				`Processing finished: ${JSON.stringify(processingResult)}`,
				accountUrl
			)
		);

		return urls;
	}

	private async readAndSaveAccountItems(
		page: Page,
		pageService: AccountPageService,
		database: Database,
		accountId: number,
		urls: string[]
	): Promise<{ totalCount: number, newCount: number }> {
		const itemsUrls: string[] = await pageService.readAllAccountItems(page);
		const itemsIds: number[] = [];

		for (const itemUrl of itemsUrls) {
			const { id, url } = await database.insertItem(itemUrl);
			itemsIds.push(id);

			// add to processing
			urls.push(url);
		}

		let newCount: number = 0;
		for (const itemId of itemsIds) {
			const added = await database.insertItemToAccount(itemId, accountId);
			if (added) {
				newCount++;
			}
		}

		return { totalCount: itemsUrls.length, newCount };
	}

}
