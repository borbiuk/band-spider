import { UrlType } from '../core/band-spider';
import { BandDatabase } from '../data/db';
import { AccountEntity } from '../entities/account-entity';
import { ItemEntity } from '../entities/item-entity';
import { logger, LogSource } from './logger';
import { isAccountUrl, isEmptyString, isItemUrl, isNullOrUndefined, logMessage, onlyUnique, originalUrl } from './utils';

export interface QueueEvent {
	id: number,
	url: string,
	type: UrlType
}

export class ProcessingQueue {
	constructor(
		private readonly urls: string[] = [],
		private readonly database: BandDatabase,
		private readonly capacity: number = 500
	) {
		this.urls = urls.filter(onlyUnique);
	}

	public get size(): number {
		return this.urls.length;
	}

	public async enqueue(url: string): Promise<boolean> {
		if (this.size >= this.capacity) {
			return false;
		}

		url = originalUrl(url);

		if (!isAccountUrl(url) && !isItemUrl(url)) {
			return false;
		}

		if (this.urls.includes(url)) {
			return false;
		}

		this.urls.push(url);

		return true;
	}

	public async enqueueButch(urls: string[]): Promise<boolean> {
		if (this.size >= this.capacity) {
			return false;
		}

		urls.forEach(x => {
			this.enqueue(x);
		});

		return true;
	}

	public async dequeue(): Promise<QueueEvent> {
		const url: string = this.urls.shift();
		if (isEmptyString(url)) {
			return null;
		}

		if (isItemUrl(url)) {
			const item: ItemEntity = await this.database.item.insert(url);
			if (item.isBusy || !isNullOrUndefined(item.lastProcessingDate) || item.failedCount > 3) {
				return null;
			}

			return { id: item.id, url, type: UrlType.Item };
		}

		if (isAccountUrl(url)) {
			const account: AccountEntity = await this.database.account.insert(url);
			if (account.isBusy || !isNullOrUndefined(account.lastProcessingDate) || account.failedCount > 3) {
				return null;
			}

			return { id: account.id, url, type: UrlType.Account };
		}

		logger.error(logMessage(LogSource.Unknown, 'Invalid URL', url))

		return null;
	}
}
