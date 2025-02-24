import { UrlType } from '../core/band-spider';
import { BandDatabase } from '../data/db';
import { logger, LogSource } from './logger';
import { isAccountUrl, isEmptyString, isItemUrl, isNullOrUndefined, logMessage, onlyUnique, originalUrl } from './utils';

export interface QueueEvent {
	id: number,
	url: string,
	type: UrlType,
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

	public enqueue(url: string): boolean {
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

	public enqueueButch(urls: string[]): boolean {
		if (this.size >= this.capacity) {
			return false;
		}

		urls.forEach(x => {
			this.enqueue(x);
		});

		return true;
	}

	public async dequeue(): Promise<QueueEvent> {
		const url: string = this.shiftRandom(this.urls);
		if (isEmptyString(url)) {
			return null;
		}

		if (isItemUrl(url)) {
			const { entity } = await this.database.item.insert(url);
			if (entity.isBusy) {
				return null;
			}

			return { id: entity.id, url, type: UrlType.Item };
		}

		if (isAccountUrl(url)) {
			const { entity } = await this.database.account.insert(url);
			if (isNullOrUndefined(entity) || entity.isBusy) {
				return null;
			}

			return { id: entity.id, url, type: UrlType.Account };
		}

		logger.error(logMessage(LogSource.Unknown, 'Invalid URL', url));

		await this.database.account.removeByUrl(url);
		await this.database.item.removeByUrl(url);

		return null;
	}

	private shiftRandom(array: string[]): string {
		if (array.length === 0) {
			return null;
		}

		const randomIndex = Math.floor(Math.random() * array.length);
		const [removedElement] = array.splice(randomIndex, 1);
		return removedElement;
	}
}
