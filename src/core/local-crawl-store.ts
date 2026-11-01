import { isAccountUrl, isItemUrl, isNullOrUndefined } from '../common/utils';
import { BandDatabase } from '../data/db';
import { UrlType } from '../models/url-type';
import { saveAccountPageData } from './account/clients/account-db-client';
import type { AccountPageData } from './account/models/account-page-data';
import type { AccountPageStatistic } from './account/models/account-page-statistic';
import type { ClaimResult, CrawlStore, CrawlTask, ReleaseReason } from './crawl-store';
import { saveItemPageData } from './item/clients/item-db-client';
import type { ItemPageData } from './item/models/item-page-data';
import type { ItemPageStatistic } from './item/models/item-page-statistic';

/** The crawl store that works on the database of this process. */
export class LocalCrawlStore implements CrawlStore {
	constructor(
		private readonly database: BandDatabase,
	) {
	}

	public async resetBusy(): Promise<void> {
		await this.database.account.resetAllBusy();
		await this.database.item.resetAllBusy();
	}

	public async pendingUrls(type: UrlType, newestFirst: boolean): Promise<string[]> {
		switch (type) {
			case UrlType.Account:
				return (await this.database.account.getNotProcessed(newestFirst)).map(({ url }) => url);
			// return ([(await this.database.account.getById(1)).url])
			// return (await this.database.account.getAccountRelated(1)).map(({ url }) => url).reverse()
			case UrlType.Item:
				return (await this.database.item.getNotProcessed(newestFirst)).map(({ url }) => url);
			// return (await this.database.item.getUserItems(1)).map(({ url }) => url)
			default:
				throw new Error('Scrapping Type is invalid!');
		}
	}

	public async claim(url: string): Promise<ClaimResult> {
		if (isItemUrl(url)) {
			const { entity } = await this.database.item.insert(url);
			if (entity.isBusy) {
				return { kind: 'busy' };
			}

			await this.database.item.updateBusy(entity.id, true);
			return { kind: 'claimed', task: { id: entity.id, url, type: UrlType.Item } };
		}

		if (isAccountUrl(url)) {
			const { entity } = await this.database.account.insert(url);
			if (isNullOrUndefined(entity)) {
				return { kind: 'none' };
			}

			if (entity.isBusy) {
				return { kind: 'busy' };
			}

			await this.database.account.updateBusy(entity.id, true);
			// tabs that were read to their end before are read only up to their newest records
			const marks = await this.database.account.getScanMarks(entity.id);
			return { kind: 'claimed', task: { id: entity.id, url, type: UrlType.Account, marks } };
		}

		await this.database.account.removeByUrl(url);
		await this.database.item.removeByUrl(url);
		return { kind: 'invalid' };
	}

	public async saveItem({ id }: CrawlTask, data: ItemPageData): Promise<ItemPageStatistic> {
		const statistic = await saveItemPageData(id, data, this.database);
		await this.database.item.updateBusy(id, false);
		return statistic;
	}

	public async saveAccount({ id }: CrawlTask, data: AccountPageData): Promise<AccountPageStatistic> {
		const statistic = await saveAccountPageData(id, data, this.database);
		await this.database.account.updateBusy(id, false);
		return statistic;
	}

	public async release({ id, type }: CrawlTask, reason: ReleaseReason): Promise<void> {
		const repository = type === UrlType.Account ? this.database.account : this.database.item;

		// HTTP 429 is not a failure of the item: only release it, so it stays a candidate
		if (reason !== 'rateLimited') {
			await repository.updateFailed(id);
		}
		await repository.updateBusy(id, false);
	}
}
