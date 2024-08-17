import { Page } from 'puppeteer';
import { logger, LogSource } from '../../common/logger';
import { QueueEvent } from '../../common/processing-queue';
import { logMessage } from '../../common/utils';
import { BandDatabase } from '../../data/db';
import { AccountPageService } from '../page-services/account-page-service';

export class AccountHandler {
	private readonly pageService: AccountPageService = new AccountPageService();
	private database: BandDatabase;

	constructor() {
	}

	public async processAccount(
		page: Page,
		{ id, url }: QueueEvent,
		pageIndex: number
	): Promise<void> {
		this.database = await BandDatabase.initialize();

		// open Account url
		await page.goto(url, { timeout: 30_000, waitUntil: 'domcontentloaded' });

		// scrap and save Items
		const { newCount, totalCount } = await this.readAndSaveAccountItems(page, id);

		// save that account was processed now
		await this.database.account.updateProcessingDate(id);

		logger.info(
			logMessage(LogSource.Account, `[${pageIndex}]\tProcessing finished: [${newCount}/${totalCount}]\t`, url)
		);
	}

	private async readAndSaveAccountItems(
		page: Page,
		accountId: number
	): Promise<{ totalCount: number, newCount: number }> {
		const { totalCount, itemsUrls } = await this.pageService.readAllAccountItems(page);
		const itemsIds: number[] = [];

		for (const itemUrl of itemsUrls) {
			const { id } = await this.database.item.insert(itemUrl);
			itemsIds.push(id);
		}

		let newCount: number = 0;
		for (const itemId of itemsIds) {
			const added = await this.database.account.addItem(accountId, itemId);
			if (added) {
				newCount++;
			}
		}

		return { totalCount: totalCount, newCount };
	}

}
