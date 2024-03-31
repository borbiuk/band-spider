import { Page } from 'puppeteer';
import { logger } from '../../common/logger';
import { Database } from '../../data/db';
import { AccountPageService } from '../page-services/account-page-service';

export class AccountHandler {
	public async processAccount(
		page: Page,
		pageService: AccountPageService,
		database: Database,
		accountUrl: string
	): Promise<string[]> {
		const urls: string[] = [];

		// open url and show all accounts
		await page.goto(accountUrl, { timeout: 10_000, waitUntil: 'networkidle0' });

		// save Account
		const { id } = await database.insertAccount(accountUrl);

		// scrap and save Items
		const itemsCount: number = await this.readAndSaveAccountItems(page, pageService, database, id, urls);

		logger.debug({
			message: 'Account processing finished!',
			url: accountUrl,
			items: itemsCount,
		});

		return urls;
	}

	private async readAndSaveAccountItems(page: Page, pageService: AccountPageService, database:Database, accountId: number, urls: string[]) : Promise<number> {
		let relationsCount: number = 0;

		try {
			const itemsUrls: string[] = await pageService.readAllAccountItems(page);

			const itemsIds: number[] = [];

			for (const itemUrl of itemsUrls) {
				const { id, url } = await database.insertItem(itemUrl);
				itemsIds.push(id);

				// add to processing
				urls.push(url);
			}

			for (const itemId of itemsIds) {
				const added = await database.insertItemToAccount(itemId, accountId);
				if (added) {
					relationsCount++;
				}
			}
		}
		catch (error) {
			logger.error(error, '[Account] Account items saving failed!');
		}

		return relationsCount;
	}

}
