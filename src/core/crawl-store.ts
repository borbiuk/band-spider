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

/** What `claim` found for a URL. */
export type ClaimResult =
	| { kind: 'claimed', task: CrawlTask }
	/** Somebody works on the URL now. */
	| { kind: 'busy' }
	/** The store has no row for the URL. */
	| { kind: 'none' }
	/** The URL is not an account or an item URL: the store forgets it. */
	| { kind: 'invalid' };

/** Why a task is given back without a saved result. */
export type ReleaseReason = 'rateLimited' | 'failed' | 'notFound';

/** Where the crawler takes URLs from and where it puts what it read. It knows nothing about the DB. */
export interface CrawlStore {
	/** Marks all URLs as not busy, for the start of a run. */
	resetBusy(): Promise<void>;
	/** URLs that were not processed yet. */
	pendingUrls(type: UrlType, newestFirst: boolean): Promise<string[]>;
	claim(url: string): Promise<ClaimResult>;
	/** Saves the page and releases the task. */
	saveItem(task: CrawlTask, data: ItemPageData): Promise<ItemPageStatistic>;
	/** Saves the page and releases the task. */
	saveAccount(task: CrawlTask, data: AccountPageData): Promise<AccountPageStatistic>;
	/** Gives the task back. `rateLimited` is not counted as a failure, the other reasons are. */
	release(task: CrawlTask, reason: ReleaseReason): Promise<void>;
}
