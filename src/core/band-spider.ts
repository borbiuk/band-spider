import { errorMessage, PageNotFoundError } from '../common/errors';
import { HttpClient } from '../common/http-client';
import { errorColor, logger, LogSource, speedColor, successColor } from '../common/logger';
import { RateLimitedError, RateLimitGate } from '../common/rate-limit-gate';
import { isAccountUrl, isItemUrl, isNullOrUndefined, logMessage } from '../common/utils';
import type { BandSpiderOptions } from '../config';
import { BandDatabase } from '../data/db';
import type { ItemRepository } from '../data/repositories/item-repository';
import { UrlType } from '../models/url-type';
import { processAccount } from './account/account-handler';
import { processItem } from './item/item-handler';
import { FetchPageReader, PageReader, PageSource } from './page-reader';
import { ProcessingQueue, QueueEvent } from './processing-queue';

/** What `processUrl` needs to process one URL type. */
interface UrlTypeHandler {
	/** The rows of the type: they are marked busy while processed, and failed when processing fails. */
	repository: Pick<ItemRepository, 'updateBusy' | 'updateFailed'>;
	process: typeof processItem;
	source: LogSource;
}

enum UrlResult {
	Processed,
	Failed,
	/** Bandcamp answered HTTP 429: the URL is not counted as failed and is tried again after the pause. */
	RateLimited,
}

export class BandSpider {
	private readonly statistic = {
		processed: 0,
		skipped: 0,
		failed: 0,
		rateLimited: 0,
		start: null as number | null,
	};

	// one pause for all workers after HTTP 429
	private readonly rateLimitGate = new RateLimitGate();

	// take the newest unprocessed URLs from the DB first (`--reverse`)
	private newestFirst = false;

	constructor(
		private readonly database: BandDatabase,
	) {
	}

	public async run(
		{
			concurrency,
			type,
			reverse,
		}: BandSpiderOptions,
		/** When aborted, every worker stops after its current URL. */
		stop: AbortSignal = new AbortController().signal,
	): Promise<void> {

		this.newestFirst = reverse;

		logger.debug('DB preparing ...');
		await this.database.account.resetAllBusy();
		await this.database.item.resetAllBusy();
		logger.debug('DB ready!');

		// init queue
		logger.debug('Queue init...');
		const queue: ProcessingQueue = new ProcessingQueue(
			await this.getInitialUrlsToProcess(type),
			this.database
		);
		logger.debug('Queue ready!');

		const createSource = this.createFetchSourceFactory();

		// create jobs
		logger.debug(`${concurrency} Jobs (HTTP) init starting...`);
		const promises: Promise<void>[] = Array.from({ length: concurrency })
			.map(async (_, id: number) => {
				return this.startPageProcessing(
					await createSource(id),
					queue,
					type,
					id,
					stop,
				);
			});
		logger.debug('Jobs started!');

		// run jobs
		await Promise.all(promises)
	}

	/** Plain HTTP: one client for all workers, so the pacing and the 429 pause are shared. */
	private createFetchSourceFactory(): (id: number) => Promise<PageSource> {
		const http = new HttpClient(this.rateLimitGate, {
			onRateLimited: (url, retryAfter) => this.pauseOnRateLimit(url, retryAfter),
		});
		const reader = new FetchPageReader(http);

		return async () => ({
			reader,
			afterUrl: async () => { },
			close: async () => { },
		});
	}

	private async startPageProcessing(
		source: PageSource,
		queue: ProcessingQueue,
		type: UrlType,
		id: number,
		stop: AbortSignal,
	) {
		if (isNullOrUndefined(this.statistic.start)) {
			this.statistic.start = new Date().getTime()
		}

		try {
			await this.processQueue(source, queue, type, id, stop);
		} finally {
			await source.close();
		}
		logger.info(
			logMessage(LogSource.Browser, `[${String(id).padEnd(2)}] Completed!`)
		);
	}

	private async processQueue(
		source: PageSource,
		queue: ProcessingQueue,
		type: UrlType,
		id: number,
		stop: AbortSignal,
	): Promise<void> {
		while (!stop.aborted) {
			// do not take a URL, nor refill the queue, while the pause after HTTP 429 is active
			await this.rateLimitGate.wait();
			if (stop.aborted) {
				break;
			}

			// fill queue
			if (queue.size === 0) {
				await this.enqueueFromDb(queue, type);
				if (queue.size === 0) {
					break;
				}
			}

			// dequeue 
			const event: QueueEvent = await queue.dequeue();
			if (isNullOrUndefined(event)) {
				continue;
			}

			// process
			const result = await this.processUrl(
				event,
				source.reader,
				id,
				// feed new URLs straight into the queue, the DB scan stays as the refill path
				(urls) => urls
					.filter(x => this.isUrlOfType(type, x))
					.forEach(x => queue.enqueue(x)),
			);

			// update statistic
			if (result === UrlResult.Processed) {
				this.statistic.processed++;
				this.rateLimitGate.reportSuccess();
			} else if (result === UrlResult.RateLimited) {
				this.statistic.rateLimited++;
				// not lost: if the queue is full, the next refill from the DB picks it up
				queue.enqueue(event.url);
			} else {
				this.statistic.failed++;
			}

			if ((this.statistic.processed + this.statistic.failed) % 50 === 0) {
				logger.debug(
					logMessage(
						LogSource.Main,
						`Processed: ${successColor(this.statistic.processed).padEnd(4)}; Failed: ${errorColor(this.statistic.failed).padEnd(4)}; Rate limited: ${this.statistic.rateLimited}; Speed: ${speedColor((this.statistic.processed / ((new Date().getTime() - this.statistic.start) / 1000)).toFixed(2)).padEnd(4)}`
							.padStart(240)
					)
				);

				// if (this.statistic.processed * 1.5 < this.statistic.failed) {
				// 	await page.browser().close();
				// 	throw 'No sense to process!';
				// }
			}

			await source.afterUrl();
		}
	}

	private async processUrl(
		event: QueueEvent,
		reader: PageReader,
		pageIndex: number,
		onNewUrls: (urls: string[]) => void,
	): Promise<UrlResult> {
		const { repository, process, source } = this.handlerOf(event.type);
		try {
			await repository.updateBusy(event.id, true);
			const processed = await process(event, this.database, reader, pageIndex, onNewUrls);
			if (!processed) {
				await repository.updateFailed(event.id)
			}
			await repository.updateBusy(event.id, false);
			return processed ? UrlResult.Processed : UrlResult.Failed;
		} catch (error) {
			// HTTP 429 is not a failure of the item: only release it, so it stays a candidate
			if (error instanceof RateLimitedError) {
				await repository.updateBusy(event.id, false);
				this.pauseOnRateLimit(error.url, error.retryAfter);
				return UrlResult.RateLimited;
			}

			await repository.updateFailed(event.id)
			await repository.updateBusy(event.id, false);

			if (error instanceof PageNotFoundError) {
				logger.warn(
					logMessage(source, `[${String(pageIndex).padStart(2)}] Page did not exist`.padEnd(50), event.url)
				);
				return UrlResult.Processed;
			}

			logger.error(
				error,
				logMessage(source, `[${pageIndex}] Processing failed: ${errorMessage(error)}`, event.url)
			);

			return UrlResult.Failed;
		}
	}

	/** The rows, the handler and the log source of one URL type. */
	private handlerOf(type: UrlType): UrlTypeHandler {
		switch (type) {
			case UrlType.Account:
				return { repository: this.database.account, process: processAccount, source: LogSource.Account };
			case UrlType.Item:
				return { repository: this.database.item, process: processItem, source: LogSource.Item };
		}
	}

	/** Starts the shared pause and logs one line when a new pause starts. */
	private pauseOnRateLimit(url: string, retryAfter?: string): void {
		const pause = this.rateLimitGate.trip(retryAfter);
		if (pause.started) {
			logger.warn(
				{ url, status: 429, retryAfter: retryAfter ?? null, pauseSeconds: Math.round(pause.pauseMs / 1000), backoffLevel: pause.level },
				logMessage(LogSource.Browser, 'HTTP 429, all workers paused')
			);
		}
	}

	/**
	 * Tells if a URL is of the kind this run processes, the same as the `getNotProcessed` filters do:
	 * accounts for the account run, only track URLs for the item run.
	 */
	private isUrlOfType(type: UrlType, url: string): boolean {
		switch (type) {
			case UrlType.Account:
				return isAccountUrl(url);
			case UrlType.Item:
				return isItemUrl(url) && url.toLowerCase().includes('/track/');
			default:
				return false;
		}
	}

	private async getInitialUrlsToProcess(
		type: UrlType,
	): Promise<string[]> {
		switch (type) {
			case UrlType.Account:
				return (await this.database.account.getNotProcessed(this.newestFirst)).map(({ url }) => url);
			// return ([(await this.database.account.getById(1)).url])
			// return (await this.database.account.getAccountRelated(1)).map(({ url }) => url).reverse()
			case UrlType.Item:
				return (await this.database.item.getNotProcessed(this.newestFirst)).map(({ url }) => url);
			// return (await this.database.item.getUserItems(1)).map(({ url }) => url)
			default:
				throw new Error('Scrapping Type is invalid!');
		}
	}

	private async enqueueFromDb(
		queue: ProcessingQueue,
		type: UrlType
	): Promise<void> {
		let urls: string[] = await this.getInitialUrlsToProcess(type);
		if (urls.length !== 0) {
			await queue.enqueueBatch(urls);
		}
	}

}
