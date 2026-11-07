import { setTimeout as sleep } from 'node:timers/promises';
import { errorMessage, failureKey, FailureReport, PageNotFoundError } from './common/errors';
import { HttpClient } from './common/http-client';
import { errorColor, logger, LogSource, speedColor, successColor } from './common/logger';
import { NotFoundGuard, NotFoundVerdict } from './common/not-found-guard';
import { NoProxy, ProxySource, StaticProxy } from './common/proxy-source';
import { RateLimitedError, RateLimitGate } from './common/rate-limit-gate';
import { isNullOrUndefined, logMessage } from './common/utils';
import type { BandSpiderOptions } from './config';
import { UrlType } from './models/url-type';
import { processAccount } from './account/account-handler';
import type { CrawlStore, CrawlTask } from './crawl-store';
import { processItem } from './item/item-handler';
import { FetchPageReader, PageReader, PageSource } from './page-reader';

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
	/** The page answered 404 and got the not-found mark. */
	NotFound,
	/** A 404 that may come from a block: the URL is released without a mark and tried again later. */
	NotFoundUnsure,
}

export class BandSpider {
	private readonly statistic = {
		processed: 0,
		skipped: 0,
		failed: 0,
		rateLimited: 0,
		notFoundUnsure: 0,
		start: null as number | null,
	};

	// take the newest unprocessed URLs from the DB first (`--reverse`)
	private newestFirst = false;

	// the workers that wait for new URLs, and how many workers there are
	private readonly idleWorkers = new Set<number>();
	private workerCount = 0;

	constructor(
		private readonly store: CrawlStore,
		/** Builds the reader of a worker from its HTTP client. A test passes a fake one. */
		private readonly createReader: (http: HttpClient) => PageReader = http => new FetchPageReader(http),
		/** Called for each error that makes a URL fail, with the reason. */
		private readonly onFailure: (failure: FailureReport) => void = () => { },
		/** Builds the 404 guard of one IP. A test passes one that trusts every 404. */
		private readonly createNotFoundGuard: () => NotFoundGuard = () => new NotFoundGuard(),
	) {
	}

	/** True while every worker waits for new URLs (only with `idleWaitMs`). */
	public get isIdle(): boolean {
		return this.workerCount > 0 && this.idleWorkers.size === this.workerCount;
	}

	public async run(
		{
			concurrency,
			type,
			reverse,
			proxy,
			minDelayMs,
			maxDelayMs,
			idleWaitMs,
		}: BandSpiderOptions,
		/** When aborted, every worker stops after its current URL. */
		stop: AbortSignal = new AbortController().signal,
	): Promise<void> {

		this.newestFirst = reverse;
		this.workerCount = concurrency;
		this.idleWorkers.clear();

		const proxySource: ProxySource = proxy === undefined ? new NoProxy() : new StaticProxy(proxy);
		const source = this.createFetchSource(proxySource, { minDelayMs, maxDelayMs });

		// create jobs
		logger.debug(`${concurrency} Jobs (HTTP) init starting...`);
		const promises: Promise<void>[] = Array.from({ length: concurrency })
			.map(async (_, id: number) => {
				return this.startPageProcessing(
					this.createWorkerSource(source),
					type,
					id,
					stop,
					idleWaitMs,
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

	/**
	 * Plain HTTP: all workers share one client and one 429 pause, because they share one proxy, so
	 * one IP. The client keeps the pause between requests for all of them.
	 */
	private createFetchSource(
		proxySource: ProxySource,
		delays: { minDelayMs?: number, maxDelayMs?: number },
	): { http: HttpClient, rateLimitGate: RateLimitGate, notFoundGuard: NotFoundGuard } {
		const rateLimitGate = new RateLimitGate();
		const http = new HttpClient(rateLimitGate, {
			proxySource,
			...delays,
			onRateLimited: (url, retryAfter) => this.pauseOnRateLimit(rateLimitGate, url, retryAfter),
		});
		return { http, rateLimitGate, notFoundGuard: this.createNotFoundGuard() };
	}

	/** A worker has its own reader, but uses the shared client, gate and 404 guard (one IP). */
	private createWorkerSource(shared: { http: HttpClient, rateLimitGate: RateLimitGate, notFoundGuard: NotFoundGuard }): PageSource {
		return {
			reader: this.createReader(shared.http),
			rateLimitGate: shared.rateLimitGate,
			notFoundGuard: shared.notFoundGuard,
			afterUrl: async () => { },
			close: async () => { },
		};
	}

	private async startPageProcessing(
		source: PageSource,
		type: UrlType,
		id: number,
		stop: AbortSignal,
		idleWaitMs?: number,
	) {
		if (isNullOrUndefined(this.statistic.start)) {
			this.statistic.start = new Date().getTime()
		}

		try {
			await this.processQueue(source, type, id, stop, idleWaitMs);
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
		idleWaitMs?: number,
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
				// the CLI ends here, a long-running crawler waits for new URLs
				if (idleWaitMs === undefined) {
					break;
				}
				this.setIdle(id, true);
				await sleep(idleWaitMs, undefined, { signal: stop }).catch(() => { });
				continue;
			}
			this.setIdle(id, false);

			// process
			const result = await this.processUrl(task, source, id);

			// update statistic
			if (result === UrlResult.Processed || result === UrlResult.NotFound) {
				this.statistic.processed++;
				source.rateLimitGate.reportSuccess();
			} else if (result === UrlResult.NotFoundUnsure) {
				this.statistic.notFoundUnsure++;
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
						`Processed: ${successColor(this.statistic.processed).padEnd(4)}; Failed: ${errorColor(this.statistic.failed).padEnd(4)}; Rate limited: ${this.statistic.rateLimited}; Unsure 404: ${this.statistic.notFoundUnsure}; Speed: ${speedColor((this.statistic.processed / ((new Date().getTime() - this.statistic.start) / 1000)).toFixed(2)).padEnd(4)}`
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

	/** Logs one line when all workers start to wait and one when they get URLs again. */
	private setIdle(id: number, idle: boolean): void {
		const wasIdle = this.isIdle;
		if (idle) {
			this.idleWorkers.add(id);
		} else {
			this.idleWorkers.delete(id);
		}
		if (this.isIdle !== wasIdle) {
			logger.info(logMessage(LogSource.Main, this.isIdle ? 'No URLs to process, waiting for new ones' : 'Got URLs again, processing'));
		}
	}

	private async processUrl(
		task: CrawlTask,
		source: PageSource,
		pageIndex: number,
	): Promise<UrlResult> {
		const { process, source: logSource } = this.handlerOf(task.type);
		try {
			const processed = await process(task, this.store, source.reader, pageIndex, this.onFailure);
			if (processed) {
				source.notFoundGuard.reportPage();
			} else {
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
				return await this.releaseNotFound(task, source, pageIndex, logSource, error);
			}

			await this.store.release(task, 'failed');
			this.onFailure({ key: failureKey(error), message: errorMessage(error), url: task.url });

			logger.error(
				error,
				logMessage(logSource, `[${pageIndex}] Processing failed: ${errorMessage(error)}`, task.url)
			);

			return UrlResult.Failed;
		}
	}

	/**
	 * Releases a URL that answered 404. The not-found mark is saved only when the guard trusts the
	 * 404. Otherwise the URL is only released, and on a burst of 404s the worker pauses like on 429.
	 */
	private async releaseNotFound(
		task: CrawlTask,
		source: PageSource,
		pageIndex: number,
		logSource: LogSource,
		error: PageNotFoundError,
	): Promise<UrlResult> {
		const verdict = source.notFoundGuard.reportNotFound();
		if (verdict === NotFoundVerdict.Trusted) {
			await this.store.release(task, 'notFound');
			this.onFailure({ key: 'not-found', message: errorMessage(error), url: task.url });
			logger.warn(
				logMessage(logSource, `[${String(pageIndex).padStart(2)}] Page did not exist`.padEnd(50), task.url)
			);
			return UrlResult.NotFound;
		}

		// not a failure of the URL: only release it, so it is tried again later
		await this.store.release(task, 'rateLimited');
		this.onFailure({ key: 'not-found:unsure', message: errorMessage(error), url: task.url });
		if (verdict === NotFoundVerdict.Burst) {
			const pause = source.rateLimitGate.trip();
			if (pause.started) {
				logger.warn(
					{ url: task.url, pauseSeconds: Math.round(pause.pauseMs / 1000), backoffLevel: pause.level },
					logMessage(LogSource.Browser, 'Too many 404s, the IP may be blocked, requests paused')
				);
			}
		}
		return UrlResult.NotFoundUnsure;
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

	/** Starts the pause of the shared gate and logs one line when a new pause starts. */
	private pauseOnRateLimit(gate: RateLimitGate, url: string, retryAfter?: string): void {
		const pause = gate.trip(retryAfter);
		if (pause.started) {
			logger.warn(
				{ url, status: 429, retryAfter: retryAfter ?? null, pauseSeconds: Math.round(pause.pauseMs / 1000), backoffLevel: pause.level },
				logMessage(LogSource.Browser, 'HTTP 429, requests paused')
			);
		}
	}
}
