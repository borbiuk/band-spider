import {
	AccountPageData,
	AccountPageStatistic,
	CrawlStore,
	CrawlTask,
	ItemPageData,
	ItemPageStatistic,
	ReleaseReason,
	SerialQueue,
	UrlType,
} from '@band-spider/core';
import { RowCounts } from './counting/count-queries';
import { RowCounter } from './counting/row-counter';
import { BandDatabase } from './db';
import { saveAccountPageData } from './account/account-db-client';
import { saveItemPageData } from './item/item-db-client';
import { REPROCESS_BEFORE } from './repositories/selection';

/** How long a task is taken before it can be taken again. */
const DEFAULT_LEASE_MS = 10 * 60 * 1000;

/** How long a counted queue size is reused. Counting a big DB takes seconds and blocks the process. */
const QUEUE_LEFT_CACHE_MS = 60 * 1000;

/** How long counted DB totals are reused. A count of every table of a big DB takes long and blocks the process. */
const TOTALS_CACHE_MS = 5 * 60 * 1000;

/** The size of the DB. */
export interface DbTotals {
	countedAt: Date;
	items: number;
	itemsProcessed: number;
	accounts: number;
	accountsProcessed: number;
	itemAccountRelations: number;
	wishlistRelations: number;
	followers: number;
}

type Candidate = { id: number, url: string };

/** Control URLs are taken from accounts read in this time, or since `REPROCESS_BEFORE` when there are none. */
const CONTROL_RECENT_MS = 7 * 24 * 60 * 60 * 1000;
/** How many control URLs are read at once and how long they are reused. */
const CONTROL_POOL_SIZE = 50;
const CONTROL_CACHE_MS = 10 * 60 * 1000;

/** The crawl store that works on the database of this process. */
export class LocalCrawlStore implements CrawlStore {
	// url type and row id -> time when the lease ends. It lives in memory only: the DB schema is the same.
	private readonly leases = new Map<string, number>();

	// URLs read from the DB but not handed out yet, per type and order. One query of a big DB takes
	// about a second, so it is read once for many claims, not once per claim. Only this store hands
	// out URLs, so a candidate stays free until it is handed out.
	private readonly candidates = new Map<string, Candidate[]>();

	private controlCache: { urls: string[], at: number } | undefined;
	private totalsCache: { value: DbTotals, at: number } | undefined;
	private queueLeftCache: { value: { items: number, accounts: number }, at: number } | undefined;

	// Claims, saves and releases run one by one. Two callers never read the same candidates, and a
	// write never joins the transaction of another save (the DB has one connection).
	private readonly writes = new SerialQueue();

	constructor(
		private readonly database: BandDatabase,
		private readonly leaseMs: number = DEFAULT_LEASE_MS,
		private readonly now: () => number = Date.now,
		/** Counts off the main thread. Without it the counts run on the one connection, in the queue of the writes. */
		private readonly counter?: RowCounter,
	) {
	}

	public async resetBusy(): Promise<void> {
		await this.writes.run(async () => {
			await this.database.account.resetAllBusy();
			await this.database.item.resetAllBusy();
			this.leases.clear();
			this.candidates.clear();
			this.queueLeftCache = undefined;
			this.totalsCache = undefined;
		});
	}

	public claim(type: UrlType, count: number, newestFirst: boolean): Promise<CrawlTask[]> {
		return this.writes.run(() => this.claimNow(type, count, newestFirst));
	}

	/**
	 * How many URLs of each type wait to be claimed. Busy rows are not counted. The number can be up to a
	 * minute old: an old number is returned at once and counted again in the background, so a caller
	 * does not wait for the count and the claims and saves wait only while it runs.
	 */
	public queueLeft(): Promise<{ items: number, accounts: number }> {
		const cache = this.queueLeftCache;
		if (cache) {
			if (this.now() - cache.at >= QUEUE_LEFT_CACHE_MS) {
				this.refreshQueueLeft();
			}
			return Promise.resolve(cache.value);
		}
		return this.refreshQueueLeft();
	}

	/** The size of the DB. The numbers can be up to five minutes old and are counted again in the background, like `queueLeft`. */
	public totals(): Promise<DbTotals> {
		const cache = this.totalsCache;
		if (cache) {
			if (this.now() - cache.at >= TOTALS_CACHE_MS) {
				this.refreshTotals();
			}
			return Promise.resolve(cache.value);
		}
		return this.refreshTotals();
	}

	/** Resolves when the jobs that are queued now, also a recount in the background, are done. */
	public async idle(): Promise<void> {
		await Promise.allSettled([this.refreshQueueLeftJob, this.refreshTotalsJob]);
		await this.writes.run(async () => { });
	}

	// one recount at a time: callers that come while it runs share it
	private refreshQueueLeftJob: Promise<{ items: number, accounts: number }> | undefined;
	private refreshTotalsJob: Promise<DbTotals> | undefined;

	private refreshQueueLeft(): Promise<{ items: number, accounts: number }> {
		const count = async () => {
			const value = this.counter
				? await this.counter.queueLeft()
				: { items: await this.database.item.countNotProcessed(), accounts: await this.database.account.countNotProcessed() };
			this.queueLeftCache = { value, at: this.now() };
			return value;
		};
		this.refreshQueueLeftJob ??= (this.counter ? count() : this.writes.run(count)).finally(() => { this.refreshQueueLeftJob = undefined; });
		// a failed recount in the background must not be an unhandled rejection: the old number stays
		this.refreshQueueLeftJob.catch(() => { });
		return this.refreshQueueLeftJob;
	}

	/** The counts on the connection of this process. */
	private async countRowsHere(): Promise<RowCounts> {
		const relations = await this.database.account.countItemRelations();
		return {
			items: await this.database.item.countAll(),
			itemsProcessed: await this.database.item.countProcessed(),
			accounts: await this.database.account.countAll(),
			accountsProcessed: await this.database.account.countProcessed(),
			itemAccountRelations: relations.all,
			wishlistRelations: relations.wishlist,
			followers: await this.database.account.countFollowers(),
		};
	}

	private refreshTotals(): Promise<DbTotals> {
		const count = async () => {
			const value: DbTotals = { countedAt: new Date(this.now()), ...(this.counter ? await this.counter.rows() : await this.countRowsHere()) };
			this.totalsCache = { value, at: this.now() };
			return value;
		};
		this.refreshTotalsJob ??= (this.counter ? count() : this.writes.run(count)).finally(() => { this.refreshTotalsJob = undefined; });
		this.refreshTotalsJob.catch(() => { });
		return this.refreshTotalsJob;
	}

	public async extendLease(task: CrawlTask): Promise<boolean> {
		const key = this.leaseKey(task);
		if (!this.leases.has(key)) {
			return false;
		}

		this.leases.set(key, this.now() + this.leaseMs);
		return true;
	}

	public async saveItem(task: CrawlTask, data: ItemPageData): Promise<ItemPageStatistic> {
		return this.writes.run(async () => {
			const statistic = await saveItemPageData(task.id, data, this.database);
			await this.clearFailedWhenClean(this.database.item, task, data.errors);
			await this.database.item.updateBusy(task.id, false);
			this.leases.delete(this.leaseKey(task));
			return statistic;
		});
	}

	public async saveAccount(task: CrawlTask, data: AccountPageData): Promise<AccountPageStatistic> {
		return this.writes.run(async () => {
			const statistic = await saveAccountPageData(task.id, data, this.database);
			await this.clearFailedWhenClean(this.database.account, task, data.errors);
			await this.database.account.updateBusy(task.id, false);
			this.leases.delete(this.leaseKey(task));
			return statistic;
		});
	}

	/** A page saved without issues starts its failure count again. A page with issues is released as failed by the caller. */
	private async clearFailedWhenClean(repository: { updateFailed(id: number, clear?: boolean): Promise<void> }, task: CrawlTask, errors: readonly Error[]): Promise<void> {
		if (errors.length === 0) {
			await repository.updateFailed(task.id, true);
		}
	}

	public release(task: CrawlTask, reason: ReleaseReason): Promise<void> {
		return this.writes.run(async () => {
			const repository = this.repositoryOf(task.type);

			// HTTP 429 is not a failure of the item: only release it, so it stays a candidate
			if (reason === 'notFound') {
				// the page is gone from Bandcamp: it is not claimed again
				await repository.markNotFound(task.id);
			} else if (reason === 'failed') {
				await repository.updateFailed(task.id);
			}
			await repository.updateBusy(task.id, false);
			this.leases.delete(this.leaseKey(task));
		});
	}

	public async controlUrl(): Promise<string | undefined> {
		const cached = this.controlCache;
		const urls = cached && this.now() - cached.at < CONTROL_CACHE_MS
			? cached.urls
			: await this.writes.run(async () => {
				const account = this.database.account;
				let found = await account.getProcessedSince(new Date(this.now() - CONTROL_RECENT_MS), CONTROL_POOL_SIZE);
				if (found.length === 0) {
					found = await account.getProcessedSince(REPROCESS_BEFORE, CONTROL_POOL_SIZE);
				}
				this.controlCache = { urls: found, at: this.now() };
				return found;
			});
		// a random one: the same page is not asked for again and again
		return urls.length === 0 ? undefined : urls[Math.floor(Math.random() * urls.length)];
	}

	private async claimNow(type: UrlType, count: number, newestFirst: boolean): Promise<CrawlTask[]> {
		await this.releaseExpired();

		const tasks: CrawlTask[] = [];
		while (tasks.length < count) {
			const candidate = await this.nextCandidate(type, newestFirst);
			if (!candidate) {
				break;
			}

			const { id, url } = candidate;
			await this.repositoryOf(type).updateBusy(id, true);
			const task: CrawlTask = { id, url, type };
			if (type === UrlType.Account) {
				// tabs that were read to their end before are read only up to their newest records
				task.marks = await this.database.account.getScanMarks(id);
			}
			this.leases.set(this.leaseKey(task), this.now() + this.leaseMs);
			tasks.push(task);
		}
		return tasks;
	}

	/** The next free URL of the type. The DB is read only when the candidates of the type are used up. */
	private async nextCandidate(type: UrlType, newestFirst: boolean): Promise<Candidate | undefined> {
		const key = `${type}:${newestFirst}`;
		let list = this.candidates.get(key);
		if (!list || list.length === 0) {
			list = (await this.notProcessed(type, newestFirst)).map(({ id, url }) => ({ id, url }));
			this.candidates.set(key, list);
		}

		const candidate = list.shift();
		if (candidate) {
			// the list of the other order may have the same URL: it must not be handed out twice
			const otherKey = `${type}:${!newestFirst}`;
			const other = this.candidates.get(otherKey);
			if (other) {
				this.candidates.set(otherKey, other.filter(({ id }) => id !== candidate.id));
			}
		}
		return candidate;
	}

	/** A task whose lease ended is not worked on any more: it can be claimed again. */
	private async releaseExpired(): Promise<void> {
		for (const [key, end] of [...this.leases]) {
			if (end > this.now()) {
				continue;
			}

			const [type, id] = key.split(':');
			await this.repositoryOf(type as UrlType).updateBusy(Number(id), false);
			this.leases.delete(key);
		}
	}

	private async notProcessed(type: UrlType, newestFirst: boolean): Promise<{ id: number, url: string }[]> {
		switch (type) {
			case UrlType.Account:
				return await this.database.account.getNotProcessed(newestFirst);
			// return ([(await this.database.account.getById(1))])
			// return (await this.database.account.getAccountRelated(1)).reverse()
			case UrlType.Item:
				// only /track/ URLs: the repository filters them
				return await this.database.item.getNotProcessed(newestFirst);
			// return (await this.database.item.getUserItems(1))
			default:
				throw new Error('Scrapping Type is invalid!');
		}
	}

	private repositoryOf(type: UrlType) {
		return type === UrlType.Account ? this.database.account : this.database.item;
	}

	private leaseKey({ type, id }: CrawlTask): string {
		return `${type}:${id}`;
	}
}
