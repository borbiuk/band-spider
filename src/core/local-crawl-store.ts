import { BandDatabase } from '../data/db';
import { UrlType } from '../models/url-type';
import { saveAccountPageData } from './account/clients/account-db-client';
import type { AccountPageData } from './account/models/account-page-data';
import type { AccountPageStatistic } from './account/models/account-page-statistic';
import type { CrawlStore, CrawlTask, ReleaseReason } from './crawl-store';
import { saveItemPageData } from './item/clients/item-db-client';
import type { ItemPageData } from './item/models/item-page-data';
import type { ItemPageStatistic } from './item/models/item-page-statistic';

/** How long a task is taken before it can be taken again. */
const DEFAULT_LEASE_MS = 10 * 60 * 1000;

/** The crawl store that works on the database of this process. */
export class LocalCrawlStore implements CrawlStore {
	// url type and row id -> time when the lease ends. It lives in memory only: the DB schema is the same.
	private readonly leases = new Map<string, number>();

	// claims run one by one, so two callers never read the same candidates
	private claimQueue: Promise<unknown> = Promise.resolve();

	constructor(
		private readonly database: BandDatabase,
		private readonly leaseMs: number = DEFAULT_LEASE_MS,
		private readonly now: () => number = Date.now,
	) {
	}

	public async resetBusy(): Promise<void> {
		await this.database.account.resetAllBusy();
		await this.database.item.resetAllBusy();
		this.leases.clear();
	}

	public claim(type: UrlType, count: number, newestFirst: boolean): Promise<CrawlTask[]> {
		const result = this.claimQueue.then(() => this.claimNow(type, count, newestFirst));
		// a failed claim must not block the next ones
		this.claimQueue = result.catch(() => { });
		return result;
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
		const statistic = await saveItemPageData(task.id, data, this.database);
		await this.database.item.updateBusy(task.id, false);
		this.leases.delete(this.leaseKey(task));
		return statistic;
	}

	public async saveAccount(task: CrawlTask, data: AccountPageData): Promise<AccountPageStatistic> {
		const statistic = await saveAccountPageData(task.id, data, this.database);
		await this.database.account.updateBusy(task.id, false);
		this.leases.delete(this.leaseKey(task));
		return statistic;
	}

	public async release(task: CrawlTask, reason: ReleaseReason): Promise<void> {
		const repository = this.repositoryOf(task.type);

		// HTTP 429 is not a failure of the item: only release it, so it stays a candidate
		if (reason !== 'rateLimited') {
			await repository.updateFailed(task.id);
		}
		await repository.updateBusy(task.id, false);
		this.leases.delete(this.leaseKey(task));
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
