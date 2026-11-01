import { errorMessage, PageNotFoundError } from './common/errors';
import { HttpClient } from './common/http-client';
import { errorColor, logger, LogSource, speedColor, successColor } from './common/logger';
import { NoProxy, ProxySource, StaticProxy } from './common/proxy-source';
import { RateLimitedError, RateLimitGate } from './common/rate-limit-gate';
import { isNullOrUndefined, logMessage } from './common/utils';
import type { BandSpiderOptions } from './config';
import { UrlType } from './models/url-type';
import { processAccount } from './account/account-handler';
import type { CrawlStore, CrawlTask } from './crawl-store';
import { processItem } from './item/item-handler';
import { FetchPageReader, PageSource } from './page-reader';

/** What `processUrl` needs to process one URL type. */
interface UrlTypeHandler {
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

	// take the newest unprocessed URLs from the DB first (`--reverse`)
	private newestFirst = false;

	constructor(
		private readonly store: CrawlStore,
	) {
	}

	public async run(
		{
			concurrency,
			type,
			reverse,
			proxy,
		}: BandSpiderOptions,
		/** When aborted, every worker stops after its current URL. */
		stop: AbortSignal = new AbortController().signal,
	): Promise<void> {

		this.newestFirst = reverse;

		const proxySource: ProxySource = proxy === undefined ? new NoProxy() : new StaticProxy(proxy);
		const createSource = this.createFetchSourceFactory(proxySource);

		// create jobs
		logger.debug(`${concurrency} Jobs (HTTP) init starting...`);
		const promises: Promise<void>[] = Array.from({ length: concurrency })
			.map(async (_, id: number) => {
				return this.startPageProcessing(
					await createSource(id),
					type,
					id,
					stop,
				);
			});
		logger.debug('Jobs started!');

		// run jobs
		try {
			await Promise.all(promises);
		} finally {
			await proxySource.close();
		}
	}

	/** Plain HTTP: every worker has its own client and its own 429 pause, as if it ran from its own IP. */
	private createFetchSourceFactory(proxySource: ProxySource): (id: number) => Promise<PageSource> {
		return async () => {
			const rateLimitGate = new RateLimitGate();
			const http = new HttpClient(rateLimitGate, {
				proxySource,
				onRateLimited: (url, retryAfter) => this.pauseOnRateLimit(rateLimitGate, url, retryAfter),
			});

			return {
				reader: new FetchPageReader(http),
				rateLimitGate,
				afterUrl: async () => { },
				close: async () => { },
			};
		};
	}

	private async startPageProcessing(
		source: PageSource,
		type: UrlType,
		id: number,
		stop: AbortSignal,
	) {
		if (isNullOrUndefined(this.statistic.start)) {
			this.statistic.start = new Date().getTime()
		}

		try {
			await this.processQueue(source, type, id, stop);
		} finally {
			await source.close();
		}
		logger.info(
			logMessage(LogSource.Browser, `[${String(id).padEnd(2)}] Completed!`)
		);
	}

	private async processQueue(
		source: PageSource,
		type: UrlType,
		id: number,
		stop: AbortSignal,
	): Promise<void> {
		while (!stop.aborted) {
			// do not take a URL while the pause after HTTP 429 is active
			await source.rateLimitGate.wait();
			if (stop.aborted) {
				break;
			}

			// claim: new URLs of a page are in the store, so they come back here
			const [task] = await this.store.claim(type, 1, this.newestFirst);
			if (isNullOrUndefined(task)) {
				break;
			}

			// process
			const result = await this.processUrl(task, source, id);

			// update statistic
			if (result === UrlResult.Processed) {
				this.statistic.processed++;
				source.rateLimitGate.reportSuccess();
			} else if (result === UrlResult.RateLimited) {
				this.statistic.rateLimited++;
				// not lost: the task is released, so it is claimed again after the pause
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
		task: CrawlTask,
		source: PageSource,
		pageIndex: number,
	): Promise<UrlResult> {
		const { process, source: logSource } = this.handlerOf(task.type);
		try {
			const processed = await process(task, this.store, source.reader, pageIndex);
			if (!processed) {
				await this.store.release(task, 'failed');
			}
			return processed ? UrlResult.Processed : UrlResult.Failed;
		} catch (error) {
			// HTTP 429 is not a failure of the item: only release it, so it stays a candidate
			if (error instanceof RateLimitedError) {
				await this.store.release(task, 'rateLimited');
				this.pauseOnRateLimit(source.rateLimitGate, error.url, error.retryAfter);
				return UrlResult.RateLimited;
			}

			if (error instanceof PageNotFoundError) {
				await this.store.release(task, 'notFound');
				logger.warn(
					logMessage(logSource, `[${String(pageIndex).padStart(2)}] Page did not exist`.padEnd(50), task.url)
				);
				return UrlResult.Processed;
			}

			await this.store.release(task, 'failed');

			logger.error(
				error,
				logMessage(logSource, `[${pageIndex}] Processing failed: ${errorMessage(error)}`, task.url)
			);

			return UrlResult.Failed;
		}
	}

	/** The handler and the log source of one URL type. */
	private handlerOf(type: UrlType): UrlTypeHandler {
		switch (type) {
			case UrlType.Account:
				return { process: processAccount, source: LogSource.Account };
			case UrlType.Item:
				return { process: processItem, source: LogSource.Item };
		}
	}

	/** Starts the pause of one worker and logs one line when a new pause starts. */
	private pauseOnRateLimit(gate: RateLimitGate, url: string, retryAfter?: string): void {
		const pause = gate.trip(retryAfter);
		if (pause.started) {
			logger.warn(
				{ url, status: 429, retryAfter: retryAfter ?? null, pauseSeconds: Math.round(pause.pauseMs / 1000), backoffLevel: pause.level },
				logMessage(LogSource.Browser, 'HTTP 429, worker paused')
			);
		}
	}
}
