import type { AccountScanMarks } from '../models/account-scan-marks';
import type { UrlType } from '../models/url-type';
import type { AccountPageData } from './account/models/account-page-data';
import type { AccountPageStatistic } from './account/models/account-page-statistic';
import type { ItemPageData } from './item/models/item-page-data';
import type { ItemPageStatistic } from './item/models/item-page-statistic';

/** One URL taken from the store. It stays taken until it is saved or released. */
export interface CrawlTask {
	id: number;
	url: string;
	type: UrlType;
	/** Only for accounts: where the last complete read of each tab began. */
	marks?: AccountScanMarks;
}

/** Why a task is given back without a saved result. */
export type ReleaseReason = 'rateLimited' | 'failed' | 'notFound';

/** Where the crawler takes URLs from and where it puts what it read. It knows nothing about the DB. */
export interface CrawlStore {
	/** Marks all URLs as not busy. Only the owner of the store calls it, at the start of a run. */
	resetBusy(): Promise<void>;
	/**
	 * Takes up to `count` URLs that were not processed yet. Two callers never get the same URL.
	 * The URLs stay taken until they are saved or released, or until the lease runs out.
	 */
	claim(type: UrlType, count: number, newestFirst: boolean): Promise<CrawlTask[]>;
	/** Makes the lease of a task longer, for a task that takes long. False when the task has no lease any more. */
	extendLease(task: CrawlTask): Promise<boolean>;
	/** Saves the page and releases the task. */
	saveItem(task: CrawlTask, data: ItemPageData): Promise<ItemPageStatistic>;
	/** Saves the page and releases the task. */
	saveAccount(task: CrawlTask, data: AccountPageData): Promise<AccountPageStatistic>;
	/** Gives the task back. `rateLimited` is not counted as a failure, the other reasons are. */
	release(task: CrawlTask, reason: ReleaseReason): Promise<void>;
}
