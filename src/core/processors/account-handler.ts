import { Page } from 'puppeteer';
import { logger, LogSource } from '../../common/logger';
import { QueueEvent } from '../../common/processing-queue';
import { logMessage } from '../../common/utils';
import { BandDatabase } from '../../data/db';
import { AccountPageService } from '../page-services/account-page-service';
import { ProxyClient } from '../proxy/proxy-client';

export class AccountHandler {
	private readonly pageService: AccountPageService = new AccountPageService();
	private database: BandDatabase;

	constructor() {
	}

	public async processAccount(
		page: Page,
		{ id, url }: QueueEvent,
		pageIndex: number
	): Promise<boolean> {
		this.database = await BandDatabase.initialize();

		// open Account url
		try {
			await page.goto(url, { timeout: 3_000, waitUntil: 'domcontentloaded' });
		}
		catch (error){
			const proxyChanged = ProxyClient.initialize.changeIp();
			if (proxyChanged) {
				throw error;
			}

			logger.warn(logMessage(LogSource.Account, `[${pageIndex}]\tProcessing stopped`, url));
			return false;
		}

		// scrap and save Items
		const { newCount, totalCount } = await this.readAndSaveAccountItems(page, id);

		// save that account was processed now
		await this.database.account.updateProcessingDate(id);

		logger.info(
			logMessage(LogSource.Account, `[${pageIndex}]\tProcessing finished: [${newCount}/${totalCount}]\t`, url)
		);

		return true;
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
