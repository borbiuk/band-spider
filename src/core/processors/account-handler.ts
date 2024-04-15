import { Page } from 'puppeteer';
import { logger, LogSource } from '../../common/logger';
import { QueueEvent } from '../../common/processing-queue';
import { logMessage } from '../../common/utils';
import { BandDatabase } from '../../data/db';
import { AccountPageService } from '../page-services/account-page-service';

export class AccountHandler {
	private readonly pageService: AccountPageService = new AccountPageService();
	private database: BandDatabase;

	constructor(
		private readonly page: Page
	) {
	}

	public async processAccount(
		{ id, url }: QueueEvent
	): Promise<void> {
		this.database = await BandDatabase.initialize();

		// open url and show all accounts
		await this.page.goto(url, { timeout: 60_000, waitUntil: 'networkidle0' });

		// scrap and save Items
		const processingResult = await this.readAndSaveAccountItems(id);

		// save that account was processed now
		await this.database.account.updateProcessingDate(id);

		logger.info(
			logMessage(
				LogSource.Account,
				`Processing finished: ${JSON.stringify(processingResult)}`,
				url
			)
		);
	}

	private async readAndSaveAccountItems(
		accountId: number
	): Promise<{ totalCount: number, newCount: number }> {
		const itemsUrls: string[] = await this.pageService.readAllAccountItems(this.page);
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

		return { totalCount: itemsUrls.length, newCount };
	}

}
