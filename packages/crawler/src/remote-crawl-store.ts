import {
	claimResponseSchema,
	extendLeaseResponseSchema,
	releaseResponseSchema,
	saveAccountResponseSchema,
	saveItemResponseSchema,
} from '@band-spider/contracts';
import {
	AccountPageData,
	AccountPageStatistic,
	CrawlStore,
	CrawlTask,
	errorMessage,
	ItemPageData,
	ItemPageStatistic,
	logger,
	logMessage,
	LogSource,
	ReleaseReason,
	UrlType,
} from '@band-spider/core';
import { CrawlTransport } from './crawl-transport';
import { toAccountPageDataDto, toCrawlTask, toCrawlTaskDto, toItemPageDataDto } from './mapping';

/** How often the leases of the tasks in work are made longer. The service default lease is 10 minutes. */
export const LEASE_EXTEND_INTERVAL_MS = 60_000;

const taskKey = (task: CrawlTask): string => `${task.type}:${task.id}`;

/**
 * The CrawlStore of a crawler: every call goes to the DB service. The crawler knows nothing about the DB.
 * While a task is in work (an account with many pages can take minutes) its lease is made longer
 * from time to time, so the service does not hand the same URL to another crawler.
 */
export class RemoteCrawlStore implements CrawlStore {
	/** Tasks in work: taken and not yet saved or released. */
	private readonly active = new Map<string, CrawlTask>();
	private timer: NodeJS.Timeout | undefined;
	private extending = false;

	constructor(
		private readonly transport: CrawlTransport,
		private readonly extendIntervalMs: number = LEASE_EXTEND_INTERVAL_MS,
	) {
	}

	public async resetBusy(): Promise<void> {
		// the busy flags belong to the DB service: a crawler must never clear them for the others
		throw new Error('resetBusy is only for the owner of the store, not for a crawler');
	}

	public async claim(type: UrlType, count: number, newestFirst: boolean): Promise<CrawlTask[]> {
		const answer = await this.transport.post('/claim', { type, count, newestFirst });
		const tasks = claimResponseSchema.parse(answer).tasks.map(toCrawlTask);
		tasks.forEach(task => this.track(task));
		return tasks;
	}

	public async extendLease(task: CrawlTask): Promise<boolean> {
		const answer = await this.transport.post('/extend-lease', { task: toCrawlTaskDto(task) });
		return extendLeaseResponseSchema.parse(answer).extended;
	}

	public async saveItem(task: CrawlTask, data: ItemPageData): Promise<ItemPageStatistic> {
		try {
			const answer = await this.transport.post('/save-item', { task: toCrawlTaskDto(task), data: toItemPageDataDto(data) });
			return saveItemResponseSchema.parse(answer).statistic;
		} finally {
			this.untrack(task);
		}
	}

	public async saveAccount(task: CrawlTask, data: AccountPageData): Promise<AccountPageStatistic> {
		try {
			const answer = await this.transport.post('/save-account', { task: toCrawlTaskDto(task), data: toAccountPageDataDto(data) });
			return saveAccountResponseSchema.parse(answer).statistic;
		} finally {
			this.untrack(task);
		}
	}

	public async release(task: CrawlTask, reason: ReleaseReason): Promise<void> {
		try {
			const answer = await this.transport.post('/release', { task: toCrawlTaskDto(task), reason });
			releaseResponseSchema.parse(answer);
		} finally {
			this.untrack(task);
		}
	}

	/** Stops the lease timer. Tasks that are still in work are not released here: the owner does it. */
	public close(): void {
		this.active.clear();
		this.stopTimer();
	}

	private track(task: CrawlTask): void {
		this.active.set(taskKey(task), task);
		this.timer ??= setInterval(() => void this.extendAll(), this.extendIntervalMs).unref();
	}

	private untrack(task: CrawlTask): void {
		this.active.delete(taskKey(task));
		if (this.active.size === 0) {
			this.stopTimer();
		}
	}

	private stopTimer(): void {
		clearInterval(this.timer);
		this.timer = undefined;
	}

	private async extendAll(): Promise<void> {
		if (this.extending) {
			return;
		}
		this.extending = true;
		try {
			for (const task of [...this.active.values()]) {
				try {
					if (!await this.extendLease(task)) {
						// the service gave the URL away already: nothing to keep
						this.active.delete(taskKey(task));
						logger.warn(logMessage(LogSource.Main, 'Lease is gone', task.url));
					}
				} catch (error) {
					// the next round tries again
					logger.warn(logMessage(LogSource.Main, `Lease extend failed: ${errorMessage(error)}`, task.url));
				}
			}
		} finally {
			this.extending = false;
		}
	}
}
