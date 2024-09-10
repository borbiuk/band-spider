import { Page } from 'puppeteer';
import { logger, LogSource } from '../../common/logger';
import { QueueEvent } from '../../common/processing-queue';
import { logAccountProcessed, logMessage } from '../../common/utils';
import { BandDatabase } from '../../data/db';
import { AccountTab } from '../../models/account-tab';
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
		pageIndex: number,
		clearPageCache: () => Promise<void>
	): Promise<boolean> {
		this.database = await BandDatabase.initialize();

		// Open Account URL
		try {
			// await page.goto(url, { timeout: 2_500, waitUntil: 'load' });
			await page.goto(url);
		} catch (error) {
			if (error.message.includes('Navigation timeout')) {
				await clearPageCache();

				const proxyChanged = ProxyClient.initialize.changeIp();
				if (proxyChanged) {
					throw error;
				}
			}

			logger.warn(logMessage(LogSource.Account, `[${pageIndex}]\tProcessing stopped`, url));
			return false;
		}

		// Scrape and save data

		const {
			newCount: newItemsCount,
			totalCount: totalItemsCount
		} = await this.readAndSaveAccountData(
			page,
			id,
			AccountTab.Collection,
			40,
			(accountId, entityId) => this.database.account.addItem(accountId, entityId)
		);

		const {
			newCount: newFollowersCount,
			totalCount: totalFollowersCount
		} = await this.readAndSaveAccountData(
			page,
			id,
			AccountTab.Followers,
			40,
			(accountId, entityId) => this.database.account.addFollower(accountId, entityId)
		);

		const {
			newCount: newFollowingCount,
			totalCount: totalFollowingCount
		} = await this.readAndSaveAccountData(
			page,
			id,
			AccountTab.Following,
			45,
			(entityId, accountId) => this.database.account.addFollower(entityId, accountId)
		);

		// Save that account was processed now
		await this.database.account.updateProcessingDate(id);

		logAccountProcessed(
			url,
			pageIndex,
			newItemsCount, totalItemsCount,
			newFollowersCount, totalFollowersCount,
			newFollowingCount, totalFollowingCount
		);

		return true;
	}

	/**
	 * Generic method to read data from a tab and save it in the database.
	 *
	 * @param page - Puppeteer page instance.
	 * @param accountId - Account ID.
	 * @param tabType - Type of account tab (Collection, Followers, Following).
	 * @param countOnPage - The number of items to read on the page.
	 * @param saveMethod - The method to save data (either add item or add follower).
	 * @returns An object containing the total and new counts of items or followers.
	 */
	private async readAndSaveAccountData(
		page: Page,
		accountId: number,
		tabType: AccountTab,
		countOnPage: number,
		saveMethod: (accountId: number, entityId: number) => Promise<boolean>
	): Promise<{ totalCount: number, newCount: number }> {
		const { total, data } = await this.pageService.read(page, tabType, countOnPage);
		const entityIds: number[] = [];

		let newCount: number = 0;
		for (const entityUrl of data) {
			const { entity: { id }, isInserted } = await this.database.account.insert(entityUrl);
			entityIds.push(id);

			if (isInserted) {
				newCount++;
			}
		}

		for (const entityId of entityIds) {
			await saveMethod(accountId, entityId);
		}

		return { totalCount: total, newCount };
	}
}
