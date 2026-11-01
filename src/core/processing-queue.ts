import { logger, LogSource } from '../common/logger';
import { isAccountUrl, isEmptyString, isItemUrl, logMessage, onlyUnique, originalUrl } from '../common/utils';
import type { CrawlStore, CrawlTask } from './crawl-store';

export class ProcessingQueue {
	// same content as `urls`, for O(1) membership checks
	private readonly known: Set<string>;

	constructor(
		private readonly urls: string[] = [],
		private readonly store: CrawlStore,
		private readonly capacity: number = 500
	) {
		this.urls = urls.filter(onlyUnique);
		this.known = new Set(this.urls);
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

		if (this.known.has(url)) {
			return false;
		}

		this.urls.push(url);
		this.known.add(url);

		return true;
	}

	public enqueueBatch(urls: string[]): boolean {
		if (this.size >= this.capacity) {
			return false;
		}

		urls.forEach(x => {
			this.enqueue(x);
		});

		return true;
	}

	public async dequeue(): Promise<CrawlTask> {
		const url: string = this.shiftRandom(this.urls);
		if (isEmptyString(url)) {
			return null;
		}
		this.known.delete(url);

		const result = await this.store.claim(url);
		switch (result.kind) {
			case 'claimed':
				return result.task;
			case 'busy':
				this.putBack(url);
				return null;
			case 'invalid':
				logger.error(logMessage(LogSource.Unknown, 'Invalid URL', url));
				return null;
			default:
				return null;
		}
	}

	/** Returns a URL that could not be processed right now, so it is not lost. */
	private putBack(url: string): void {
		if (this.known.has(url)) {
			return;
		}

		this.urls.push(url);
		this.known.add(url);
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
