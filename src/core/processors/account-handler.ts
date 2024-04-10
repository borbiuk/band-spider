import { Page } from 'puppeteer';
import { logger, Source } from '../../common/logger';
import { isNullOrUndefined, logMessage } from '../../common/utils';
import { Database } from '../../data/db';
import { AccountPageService } from '../page-services/account-page-service';

export class AccountHandler {
	private readonly pageService: AccountPageService = new AccountPageService();
	private database: Database;

	public async processAccount(
		page: Page,
		accountUrl: string
	): Promise<string[]> {
		if (isNullOrUndefined(this.database)) {
			this.database = await Database.initialize();
		}

		const urls: string[] = [];

		// open url and show all accounts
		await page.goto(accountUrl, { timeout: 30_000, waitUntil: 'domcontentloaded' });

		// save Account
		const { id } = await this.database.insertAccount(accountUrl);

		// scrap and save Items
		const processingResult = await this.readAndSaveAccountItems(page, id, urls);

		// save that account was processed now
		await this.database.updateAccountProcessingDate(id);

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
		accountId: number,
		urls: string[]
	): Promise<{ totalCount: number, newCount: number }> {
		const itemsUrls: string[] = await this.pageService.readAllAccountItems(page);
		const itemsIds: number[] = [];

		for (const itemUrl of itemsUrls) {
			const { id, url } = await this.database.insertItem(itemUrl);
			itemsIds.push(id);

			// add to processing
			urls.push(url);
		}

		let newCount: number = 0;
		for (const itemId of itemsIds) {
			const added = await this.database.insertItemToAccount(itemId, accountId);
			if (added) {
				newCount++;
			}
		}

		return { totalCount: itemsUrls.length, newCount };
	}

}
