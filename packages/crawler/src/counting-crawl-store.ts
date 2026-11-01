import {
	AccountPageData,
	AccountPageStatistic,
	CrawlStore,
	CrawlTask,
	ItemPageData,
	ItemPageStatistic,
	ReleaseReason,
	UrlType,
} from '@band-spider/core';

/** How many URLs of each result this crawler had. */
export interface CrawlerCounts {
	claimed: number;
	/** Pages saved. A page saved with scraping issues is also counted in `failed`, the handler releases it. */
	saved: number;
	failed: number;
	rateLimited: number;
	notFound: number;
}

export const emptyCounts = (): CrawlerCounts => ({ claimed: 0, saved: 0, failed: 0, rateLimited: 0, notFound: 0 });

/** Passes every call on and counts the results. */
export class CountingCrawlStore implements CrawlStore {
	public readonly counts: CrawlerCounts = emptyCounts();

	constructor(
		private readonly inner: CrawlStore,
		private readonly onChange: (counts: CrawlerCounts) => void = () => { },
	) {
	}

	public resetBusy(): Promise<void> {
		return this.inner.resetBusy();
	}

	public async claim(type: UrlType, count: number, newestFirst: boolean): Promise<CrawlTask[]> {
		const tasks = await this.inner.claim(type, count, newestFirst);
		this.counts.claimed += tasks.length;
		if (tasks.length > 0) {
			this.onChange({ ...this.counts });
		}
		return tasks;
	}

	public extendLease(task: CrawlTask): Promise<boolean> {
		return this.inner.extendLease(task);
	}

	public async saveItem(task: CrawlTask, data: ItemPageData): Promise<ItemPageStatistic> {
		const statistic = await this.inner.saveItem(task, data);
		this.counts.saved++;
		this.onChange({ ...this.counts });
		return statistic;
	}

	public async saveAccount(task: CrawlTask, data: AccountPageData): Promise<AccountPageStatistic> {
		const statistic = await this.inner.saveAccount(task, data);
		this.counts.saved++;
		this.onChange({ ...this.counts });
		return statistic;
	}

	public async release(task: CrawlTask, reason: ReleaseReason): Promise<void> {
		await this.inner.release(task, reason);
		this.counts[reason]++;
		this.onChange({ ...this.counts });
	}
}
