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
import { BandDatabase } from './db';
import { saveAccountPageData } from './account/account-db-client';
import { saveItemPageData } from './item/item-db-client';

/** How long a task is taken before it can be taken again. */
const DEFAULT_LEASE_MS = 10 * 60 * 1000;

/** The crawl store that works on the database of this process. */
export class LocalCrawlStore implements CrawlStore {
	// url type and row id -> time when the lease ends. It lives in memory only: the DB schema is the same.
	private readonly leases = new Map<string, number>();

	// Claims, saves and releases run one by one. Two callers never read the same candidates, and a
	// write never joins the transaction of another save (the DB has one connection).
	private readonly writes = new SerialQueue();

	constructor(
		private readonly database: BandDatabase,
		private readonly leaseMs: number = DEFAULT_LEASE_MS,
		private readonly now: () => number = Date.now,
	) {
	}

	public async resetBusy(): Promise<void> {
		await this.writes.run(async () => {
			await this.database.account.resetAllBusy();
			await this.database.item.resetAllBusy();
			this.leases.clear();
		});
	}

	public claim(type: UrlType, count: number, newestFirst: boolean): Promise<CrawlTask[]> {
		return this.writes.run(() => this.claimNow(type, count, newestFirst));
	}

	/** How many URLs of each type wait to be claimed. Busy rows are not counted. */
	public queueLeft(): Promise<{ items: number, accounts: number }> {
		return this.writes.run(async () => ({
			items: await this.database.item.countNotProcessed(),
			accounts: await this.database.account.countNotProcessed(),
		}));
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
			await this.database.item.updateBusy(task.id, false);
			this.leases.delete(this.leaseKey(task));
			return statistic;
		});
	}

	public async saveAccount(task: CrawlTask, data: AccountPageData): Promise<AccountPageStatistic> {
		return this.writes.run(async () => {
			const statistic = await saveAccountPageData(task.id, data, this.database);
			await this.database.account.updateBusy(task.id, false);
			this.leases.delete(this.leaseKey(task));
			return statistic;
		});
	}

	public release(task: CrawlTask, reason: ReleaseReason): Promise<void> {
		return this.writes.run(async () => {
			const repository = this.repositoryOf(task.type);

			// HTTP 429 is not a failure of the item: only release it, so it stays a candidate
			if (reason !== 'rateLimited') {
				await repository.updateFailed(task.id);
			}
			await repository.updateBusy(task.id, false);
			this.leases.delete(this.leaseKey(task));
		});
	}

	private async claimNow(type: UrlType, count: number, newestFirst: boolean): Promise<CrawlTask[]> {
		await this.releaseExpired();

		const tasks: CrawlTask[] = [];
		for (const { id, url } of await this.notProcessed(type, newestFirst)) {
			if (tasks.length >= count) {
				break;
			}

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
