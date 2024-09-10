import { Page } from 'puppeteer';
import { logger, LogSource } from '../../common/logger';
import { QueueEvent } from '../../common/processing-queue';
import { logAccountProcessed, logMessage } from '../../common/utils';
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
		pageIndex: number,
		clearPageCache: () => Promise<void>
	): Promise<boolean> {
		this.database = await BandDatabase.initialize();

		// open Account url
		try {
			await page.goto(url, { timeout: 2_500, waitUntil: 'domcontentloaded' });
		} catch (error) {
			await clearPageCache();

			const proxyChanged = ProxyClient.initialize.changeIp();
			if (proxyChanged) {
				throw error;
			}

			logger.warn(logMessage(LogSource.Account, `[${pageIndex}]\tProcessing stopped`, url));
			return false;
		}

		// scrap and save data
		const { newItemsCount, totalItemsCount } = await this.readAndSaveAccountItems(page, id);
		const { totalFollowersCount, newFollowersCount } = await this.readAndSaveAccountFollowers(page, id);
		const { totalFollowingCount, newFollowingCount } = await this.readAndSaveAccountFollowing(page, id);

		// save that account was processed now
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

	private async readAndSaveAccountItems(
		page: Page,
		accountId: number
	): Promise<{ totalItemsCount: number, newItemsCount: number }> {
		const { totalCount, itemsUrls } = await this.pageService.readAllAccountItems(page);
		const itemsIds: number[] = [];

		for (const itemUrl of itemsUrls) {
			const { entity: { id } } = await this.database.item.insert(itemUrl);
			itemsIds.push(id);
		}

		let newCount: number = 0;
		for (const itemId of itemsIds) {
			const added = await this.database.account.addItem(accountId, itemId);
			if (added) {
				newCount++;
			}
		}

		return { totalItemsCount: totalCount, newItemsCount: newCount };
	}

	private async readAndSaveAccountFollowers(page: Page, accountId: number): Promise<{ totalFollowersCount: number, newFollowersCount: number }> {
		const { totalCount, accountUrls } = await this.pageService.readAllFollowers(page);
		const followersIds: number[] = [];

		let newAccountsCount: number = 0;
		for (const accountUrl of accountUrls) {
			const { entity: { id }, isInserted } = await this.database.account.insert(accountUrl);
			followersIds.push(id);

			if (isInserted) {
				newAccountsCount++;
			}
		}

		for (const followerId of followersIds) {
			await this.database.account.addFollower(accountId, followerId);
		}

		return { totalFollowersCount: totalCount, newFollowersCount: newAccountsCount };
	}

	private async readAndSaveAccountFollowing(page: Page, accountId: number): Promise<{ totalFollowingCount: number, newFollowingCount: number }> {
		const { totalCount, accountUrls } = await this.pageService.readAllFollowing(page);
		const followingsIds: number[] = [];

		let newAccountsCount: number = 0;
		for (const accountUrl of accountUrls) {
			const { entity: { id }, isInserted } = await this.database.account.insert(accountUrl);
			followingsIds.push(id);
			if (isInserted) {
				newAccountsCount++;
			}
		}

		for (const followerId of followingsIds) {
			await this.database.account.addFollower(followerId, accountId);
		}

		return { totalFollowingCount: totalCount, newFollowingCount: newAccountsCount };
	}

}
