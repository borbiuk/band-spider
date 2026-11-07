import { setTimeout as sleep } from 'node:timers/promises';
import { BurstGuard, BurstVerdict } from './common/burst-guard';
import { errorMessage, failureKey, FailureReport, isConnectionFailure, PageNotFoundError } from './common/errors';
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
import { FetchPageReader, PageReader, PageSource } from './page-reader';

/** What `processUrl` needs to process one URL type. */
interface UrlTypeHandler {
	process: typeof processItem;
	source: LogSource;
}

/**
 * After this many pauses in a row with no page read between them the crawler stops with an error.
 * The pauses grow from 30 seconds to 15 minutes, so this is about an hour of failures.
 */
export const MAX_PAUSES_IN_ROW = 8;

enum UrlResult {
	Processed,
	Failed,
	/** Bandcamp answered HTTP 429: the URL is not counted as failed and is tried again after the pause. */
	RateLimited,
	/** The page answered 404 and got the not-found mark. */
	NotFound,
	/** A 404 that may come from a block: the URL is released without a mark and tried again later. */
	NotFoundUnsure,
	/** A network error that may come from the proxy or a block: the URL is released without counting it. */
	ConnectionUnsure,
}

export class BandSpider {
	private readonly statistic = {
		processed: 0,
		skipped: 0,
		failed: 0,
		rateLimited: 0,
		notFoundUnsure: 0,
		connectionUnsure: 0,
		start: null as number | null,
	};

	// take the newest unprocessed URLs from the DB first (`--reverse`)
	private newestFirst = false;

	// the workers that wait for new URLs, and how many workers there are
	private readonly idleWorkers = new Set<number>();
	private workerCount = 0;

	// aborted when requests keep failing for too long; `haltReason` says why
	private halt = new AbortController();
	private haltReason: Error | null = null;

	constructor(
		private readonly store: CrawlStore,
		/** Builds the reader of a worker from its HTTP client. A test passes a fake one. */
		private readonly createReader: (http: HttpClient) => PageReader = http => new FetchPageReader(http),
		/** Called for each error that makes a URL fail, with the reason. */
		private readonly onFailure: (failure: FailureReport) => void = () => { },
		/** Builds a guard of one IP, one for 404s and one for network errors. A test passes one that trusts every answer. */
		private readonly createGuard: () => BurstGuard = () => new BurstGuard(),
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
		this.halt = new AbortController();
		this.haltReason = null;
		// the workers also stop when requests keep failing
		const workersStop = AbortSignal.any([stop, this.halt.signal]);

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
					workersStop,
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
		if (this.haltReason !== null) {
			throw this.haltReason;
		}
	}

	/**
	 * Plain HTTP: all workers share one client and one 429 pause, because they share one proxy, so
	 * one IP. The client keeps the pause between requests for all of them.
	 */
	private createFetchSource(
		proxySource: ProxySource,
		delays: { minDelayMs?: number, maxDelayMs?: number },
	): { http: HttpClient, rateLimitGate: RateLimitGate, notFoundGuard: BurstGuard, connectionGuard: BurstGuard } {
		const rateLimitGate = new RateLimitGate();
		const http = new HttpClient(rateLimitGate, {
			proxySource,
			...delays,
			onRateLimited: (url, retryAfter) => this.pauseOnRateLimit(rateLimitGate, url, retryAfter),
		});
		return { http, rateLimitGate, notFoundGuard: this.createGuard(), connectionGuard: this.createGuard() };
	}

	/** A worker has its own reader, but uses the shared client, gate and guards (one IP). */
	private createWorkerSource(shared: { http: HttpClient, rateLimitGate: RateLimitGate, notFoundGuard: BurstGuard, connectionGuard: BurstGuard }): PageSource {
		return {
			reader: this.createReader(shared.http),
			rateLimitGate: shared.rateLimitGate,
			notFoundGuard: shared.notFoundGuard,
			connectionGuard: shared.connectionGuard,
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
			await source.rateLimitGate.wait(stop);
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
			} else if (result === UrlResult.ConnectionUnsure) {
				this.statistic.connectionUnsure++;
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
						`Processed: ${successColor(this.statistic.processed).padEnd(4)}; Failed: ${errorColor(this.statistic.failed).padEnd(4)}; Rate limited: ${this.statistic.rateLimited}; Unsure 404: ${this.statistic.notFoundUnsure}; Unsure network errors: ${this.statistic.connectionUnsure}; Speed: ${speedColor((this.statistic.processed / ((new Date().getTime() - this.statistic.start) / 1000)).toFixed(2)).padEnd(4)}`
							.padStart(240)
					)
				);

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
			// the page was answered, failed or not
			source.notFoundGuard.reportOk();
			source.connectionGuard.reportOk();
			if (!processed) {
				await this.store.release(task, 'failed');
			}
			return processed ? UrlResult.Processed : UrlResult.Failed;
		} catch (error) {
			// HTTP 429 is not a failure of the item: only release it, so it stays a candidate
			if (error instanceof RateLimitedError) {
				source.connectionGuard.reportOk();
				await this.store.release(task, 'rateLimited');
				this.pauseOnRateLimit(source.rateLimitGate, error.url, error.retryAfter);
				return UrlResult.RateLimited;
			}

			if (error instanceof PageNotFoundError) {
				source.connectionGuard.reportOk();
				return await this.releaseNotFound(task, source, pageIndex, logSource, error);
			}

			if (isConnectionFailure(error)) {
				return await this.releaseConnectionFailure(task, source, pageIndex, logSource, error);
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
		const verdict = source.notFoundGuard.reportSuspect();
		if (verdict === BurstVerdict.Trusted) {
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
		if (verdict === BurstVerdict.Burst) {
			this.pause(source.rateLimitGate, 'Too many 404s, the IP may be blocked, requests paused', { url: task.url });
		}
		return UrlResult.NotFoundUnsure;
	}

	/**
	 * Releases a URL that failed with a network error, a timeout, HTTP 403 or 5xx. It counts as a
	 * failure of the URL only when the guard trusts it. Otherwise the URL is only released, and on a
	 * burst of such errors the worker pauses like on 429.
	 */
	private async releaseConnectionFailure(
		task: CrawlTask,
		source: PageSource,
		pageIndex: number,
		logSource: LogSource,
		error: unknown,
	): Promise<UrlResult> {
		const verdict = source.connectionGuard.reportSuspect();
		const trusted = verdict === BurstVerdict.Trusted;
		await this.store.release(task, trusted ? 'failed' : 'rateLimited');
		this.onFailure({ key: failureKey(error), message: errorMessage(error), url: task.url });
		logger.error(
			logMessage(logSource, `[${pageIndex}] Request failed${trusted ? '' : ', not counted'}: ${errorMessage(error)}`, task.url)
		);
		if (verdict === BurstVerdict.Burst) {
			this.pause(source.rateLimitGate, 'Too many network errors, the proxy or the IP may be down, requests paused', { url: task.url });
		}
		return trusted ? UrlResult.Failed : UrlResult.ConnectionUnsure;
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

	/** Starts the pause of the shared gate after HTTP 429. */
	private pauseOnRateLimit(gate: RateLimitGate, url: string, retryAfter?: string): void {
		this.pause(gate, 'HTTP 429, requests paused', { url, status: 429, retryAfter: retryAfter ?? null }, retryAfter);
	}

	/**
	 * Starts the pause of the shared gate and logs one line when a new pause starts. After
	 * `MAX_PAUSES_IN_ROW` pauses with no page read between them, all workers stop with an error.
	 */
	private pause(gate: RateLimitGate, message: string, details: Record<string, unknown>, retryAfter?: string): void {
		const pause = gate.trip(retryAfter);
		if (!pause.started) {
			return;
		}
		logger.warn(
			{ ...details, pauseSeconds: Math.round(pause.pauseMs / 1000), backoffLevel: pause.level },
			logMessage(LogSource.Browser, message)
		);
		if (pause.level >= MAX_PAUSES_IN_ROW && this.haltReason === null) {
			this.haltReason = new Error(`Requests kept failing: ${pause.level} pauses in a row with no page read, the last: ${message}`);
			logger.error(logMessage(LogSource.Main, `${this.haltReason.message}. Stopping the crawler`));
			this.halt.abort();
		}
	}
}
