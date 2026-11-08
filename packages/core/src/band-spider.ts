import { setTimeout as sleep } from 'node:timers/promises';
import { errorMessage, failureKey, FailureReport, isConnectionFailure, PageNotFoundError } from './common/errors';
import { HttpClient } from './common/http-client';
import { errorColor, logger, LogSource, speedColor, successColor } from './common/logger';
import { NoProxy, ProxySource, StaticProxy } from './common/proxy-source';
import { RateLimitedError, RateLimitGate } from './common/rate-limit-gate';
import { HeldAnswer, SuspectAnswers, SuspectAnswersOptions, SuspectKind } from './common/suspect-answers';
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

/** After the first failed control request the crawler waits this long, then it checks again. */
export const CONTROL_PAUSE_MS = 5 * 60_000;

/** A warning about the proxy of the crawler, set when a control request failed. */
export interface SpiderWarning {
	/** What kind of answers made the control request: `notFound` for 404s, `connection` for network errors. */
	kind: SuspectKind;
	message: string;
	/** When the control request failed, in ms. */
	since: number;
}

/** Options a test can change. */
export interface BandSpiderTuning {
	suspects?: SuspectAnswersOptions;
	/** The pause after the first failed control request. */
	controlPauseMs?: number;
}

enum UrlResult {
	Processed,
	Failed,
	/** Bandcamp answered HTTP 429: the URL is not counted as failed and is tried again after the pause. */
	RateLimited,
	/** A 404 or a network error: the URL waits until it is clear whether the proxy worked. */
	Held,
}

/** A URL with a suspect answer, kept until it is confirmed or dropped. */
interface HeldTask {
	task: CrawlTask;
	error: unknown;
	pageIndex: number;
	logSource: LogSource;
}

const WARNING_NAME: Record<SuspectKind, string> = { notFound: '404 warning', connection: 'network warning' };

export class BandSpider {
	private readonly statistic = {
		processed: 0,
		failed: 0,
		rateLimited: 0,
		held: 0,
		start: null as number | null,
	};

	// take the newest unprocessed URLs from the DB first (`--reverse`)
	private newestFirst = false;

	// the workers that wait for new URLs, and how many workers there are
	private readonly idleWorkers = new Set<number>();
	private workerCount = 0;

	// all workers use one proxy, so these are about that proxy
	private suspects: SuspectAnswers<HeldTask>;
	private failedChecks = 0;
	private checking: Promise<void> | null = null;
	// set after the first failed control request: the next check runs right after the pause
	private recheck: SuspectKind | undefined;
	private currentWarning: SpiderWarning | undefined;

	// aborted when the proxy does not work; `haltReason` says why
	private halt = new AbortController();
	private haltReason: Error | null = null;

	constructor(
		private readonly store: CrawlStore,
		/** Builds the reader of a worker from its HTTP client. A test passes a fake one. */
		private readonly createReader: (http: HttpClient) => PageReader = http => new FetchPageReader(http),
		/** Called for each error that makes a URL fail, with the reason. */
		private readonly onFailure: (failure: FailureReport) => void = () => { },
		private readonly tuning: BandSpiderTuning = {},
	) {
		this.suspects = new SuspectAnswers(tuning.suspects);
	}

	/** True while every worker waits for new URLs (only with `idleWaitMs`). */
	public get isIdle(): boolean {
		return this.workerCount > 0 && this.idleWorkers.size === this.workerCount;
	}

	/** Set while the proxy is in doubt: a control request failed and no later one passed. */
	public get warning(): SpiderWarning | undefined {
		return this.currentWarning;
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
		this.suspects = new SuspectAnswers(this.tuning.suspects);
		this.failedChecks = 0;
		this.recheck = undefined;
		this.currentWarning = undefined;
		// the workers also stop when the proxy does not work
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
			// nothing was confirmed: the URLs are tried again later
			await this.releaseUnconfirmed(this.suspects.takeAll());
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
	): { http: HttpClient, rateLimitGate: RateLimitGate } {
		const rateLimitGate = new RateLimitGate();
		const http = new HttpClient(rateLimitGate, {
			proxySource,
			...delays,
			onRateLimited: (url, retryAfter) => this.pauseOnRateLimit(rateLimitGate, url, retryAfter),
		});
		return { http, rateLimitGate };
	}

	/** A worker has its own reader, but uses the shared client and gate (one IP). */
	private createWorkerSource(shared: { http: HttpClient, rateLimitGate: RateLimitGate }): PageSource {
		return {
			reader: this.createReader(shared.http),
			rateLimitGate: shared.rateLimitGate,
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
			// do not take a URL while a pause is active
			await source.rateLimitGate.wait(stop);
			if (stop.aborted) {
				break;
			}

			// first make clear whether the proxy works, when that is due
			await this.checkIfDue(source);
			if (stop.aborted) {
				break;
			}
			if (source.rateLimitGate.isPaused) {
				continue;
			}

			// claim: new URLs of a page are in the store, so they come back here
			const [task] = await this.store.claim(type, 1, this.newestFirst);
			if (isNullOrUndefined(task)) {
				// the CLI ends here, a long-running crawler waits for new URLs
				if (idleWaitMs === undefined) {
					// the held URLs are not left in doubt: one control request decides them
					await this.checkIfDue(source, true);
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
			if (result === UrlResult.Processed) {
				this.statistic.processed++;
				source.rateLimitGate.reportSuccess();
			} else if (result === UrlResult.Held) {
				this.statistic.held++;
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
						`Processed: ${successColor(this.statistic.processed).padEnd(4)}; Failed: ${errorColor(this.statistic.failed).padEnd(4)}; Rate limited: ${this.statistic.rateLimited}; 404 or network errors: ${this.statistic.held}; Speed: ${speedColor((this.statistic.processed / ((new Date().getTime() - this.statistic.start) / 1000)).toFixed(2)).padEnd(4)}`
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
			// the page came as expected, saved or not: the proxy works
			await this.confirm(this.suspects.reportRead());
			if (!processed) {
				await this.store.release(task, 'failed');
			}
			return processed ? UrlResult.Processed : UrlResult.Failed;
		} catch (error) {
			// HTTP 429 is not a failure of the item: only release it, so it stays a candidate
			if (error instanceof RateLimitedError) {
				this.suspects.reportOther();
				await this.store.release(task, 'rateLimited');
				this.pauseOnRateLimit(source.rateLimitGate, error.url, error.retryAfter);
				return UrlResult.RateLimited;
			}

			// the page may be gone, or the proxy may not work: the URL waits until it is clear
			if (error instanceof PageNotFoundError || isConnectionFailure(error)) {
				const kind: SuspectKind = error instanceof PageNotFoundError ? 'notFound' : 'connection';
				this.suspects.hold({ task, error, pageIndex, logSource }, kind);
				logger.debug(logMessage(logSource, `[${pageIndex}] ${kind === 'notFound' ? 'HTTP 404' : errorMessage(error)}, waits for a confirmation`, task.url));
				return UrlResult.Held;
			}

			this.suspects.reportOther();
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
	 * Runs a control request when one is due, or with `force` when any answer is held. While one
	 * runs, the other workers wait for it.
	 */
	private async checkIfDue(source: PageSource, force = false): Promise<void> {
		if (this.checking) {
			await this.checking;
			return;
		}
		const kind = this.recheck ?? this.suspects.checkDue() ?? (force ? this.suspects.oldestKind : undefined);
		if (kind === undefined) {
			return;
		}
		this.checking = this.controlCheck(source, kind).finally(() => { this.checking = null; });
		await this.checking;
	}

	/**
	 * Asks for an account page that is known to exist. When it comes as expected, the proxy works and
	 * the held answers are about their pages: they are saved. Otherwise they are dropped, and the
	 * crawler pauses after the first failed request and stops after the second.
	 */
	private async controlCheck(source: PageSource, kind: SuspectKind): Promise<void> {
		let url: string | undefined;
		try {
			url = await this.store.controlUrl();
		} catch (error) {
			// the next round tries again
			logger.warn(logMessage(LogSource.Main, `No URL for a control request: ${errorMessage(error)}`));
			return;
		}
		if (url === undefined) {
			const held = this.suspects.takeAll();
			this.recheck = undefined;
			logger.warn(logMessage(LogSource.Main, `No account was read lately, so there is no control request: ${held.length} URLs with a 404 or a network error are tried again later`));
			await this.releaseUnconfirmed(held);
			return;
		}

		let readable: boolean;
		try {
			readable = await source.reader.isAccountPageReadable(url);
		} catch (error) {
			if (error instanceof RateLimitedError) {
				// says nothing about the proxy: the check runs again after the pause
				this.pauseOnRateLimit(source.rateLimitGate, error.url, error.retryAfter);
				return;
			}
			readable = false;
		}

		const held = this.suspects.takeAll();
		if (readable) {
			logger.info(logMessage(LogSource.Main, `Control request passed: the proxy works, ${held.length} URLs with a 404 or a network error are saved as such`, url));
			if (this.currentWarning) {
				logger.warn(logMessage(LogSource.Main, `${WARNING_NAME[this.currentWarning.kind]} is cleared`));
			}
			this.failedChecks = 0;
			this.recheck = undefined;
			this.currentWarning = undefined;
			await this.confirm(held);
			return;
		}

		await this.releaseUnconfirmed(held);
		this.failedChecks++;
		const name = WARNING_NAME[kind];
		if (this.failedChecks >= 2) {
			this.currentWarning = { kind, message: 'the control request failed again, the crawler stopped', since: Date.now() };
			this.haltReason = new Error(`${name}: the control request failed twice, the proxy does not work. Start the crawler again by hand`);
			logger.error(logMessage(LogSource.Main, `${this.haltReason.message}. Stopping the crawler`, url));
			this.halt.abort();
			return;
		}
		const pauseMs = this.tuning.controlPauseMs ?? CONTROL_PAUSE_MS;
		this.currentWarning = { kind, message: `the control request failed, paused for ${Math.round(pauseMs / 60_000)} min`, since: Date.now() };
		this.recheck = kind;
		source.rateLimitGate.pauseFor(pauseMs);
		logger.warn(
			{ url, held: held.length, pauseSeconds: Math.round(pauseMs / 1000) },
			logMessage(LogSource.Browser, `${name}: the control request failed, the proxy may not work. ${held.length} URLs are tried again later, requests paused`)
		);
	}

	/** Saves the confirmed answers: a 404 gets the not-found mark, a network error counts as a failure. */
	private async confirm(held: HeldAnswer<HeldTask>[]): Promise<void> {
		for (const { item: { task, error, pageIndex, logSource }, kind } of held) {
			if (kind === 'notFound') {
				await this.store.release(task, 'notFound');
				this.onFailure({ key: 'not-found', message: errorMessage(error), url: task.url });
				logger.warn(logMessage(logSource, `[${String(pageIndex).padStart(2)}] Page did not exist`.padEnd(50), task.url));
			} else {
				await this.store.release(task, 'failed');
				this.onFailure({ key: failureKey(error), message: errorMessage(error), url: task.url });
				logger.error(logMessage(logSource, `[${pageIndex}] Request failed: ${errorMessage(error)}`, task.url));
			}
		}
	}

	/** Gives the URLs back without a mark or a count: they are tried again later. */
	private async releaseUnconfirmed(held: HeldAnswer<HeldTask>[]): Promise<void> {
		for (const { item: { task } } of held) {
			try {
				await this.store.release(task, 'rateLimited');
			} catch (error) {
				// the lease ends on its own
				logger.warn(logMessage(LogSource.Main, `Release failed: ${errorMessage(error)}`, task.url));
			}
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

	/** Starts the pause of the shared gate after HTTP 429 and logs one line when a new pause starts. */
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
