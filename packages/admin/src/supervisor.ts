import { logger, logMessage, LogSource } from '@band-spider/core';
import { z } from 'zod';
import { AdminConfig, CrawlerSetting, poolKeyOf, proxyUrlOf, proxyUrlOfEntry } from './config';
import { ConfigStore } from './config-store';
import { CrawlerMetricsTracker } from './crawler-metrics';
import { DbStats, DbStatsSource, HttpDbStatsSource } from './db-stats';
import { AdminError, conflict, notFound } from './errors';
import { ChildStatus, CrawlerCounts, ManagedChild } from './managed-child';
import { ProcessLauncher } from './process-launcher';
import { pickProxy, ProxyListSource, WebshareProxySource } from './webshare';

export interface SupervisorEntries {
	/** The script of the DB service. */
	dbService: string;
	/** The script of a crawler. */
	crawler: string;
}

export interface SupervisorOptions {
	launcher: ProcessLauncher;
	configStore: ConfigStore;
	entries: SupervisorEntries;
	/** Makes the proxy list source for an API key. The Webshare API is the default. */
	proxyListFactory?: (apiKey: string) => ProxyListSource;
	/** How long a start waits for the DB service ready message. */
	readyTimeoutMs?: number;
	/** How long a child gets to stop before it is killed. */
	stopTimeoutMs?: number;
	/** How many output lines are kept for each child. */
	logLines?: number;
	/** Reads the counters of the DB service. The default is HTTP. */
	dbStatsSource?: DbStatsSource;
	/** How often the DB service counters are read while it runs. 0 turns it off. */
	dbStatsIntervalMs?: number;
	/** Current time in ms, for the speeds of the crawlers. */
	now?: () => number;
}

export interface DbStatus extends ChildStatus {
	/** The counters of the running DB service. */
	dbStats?: DbStats;
	/** Why the counters could not be read. */
	dbStatsError?: string;
}

export interface CrawlerStatus extends ChildStatus {
	name: string;
	/** False when the crawler runs but was removed from the config. */
	configured: boolean;
}

export interface SupervisorStatus {
	db: DbStatus;
	crawlers: CrawlerStatus[];
}

/** What a listener of the supervisor gets. A log source is "db" or "crawler:<name>". */
export type SupervisorEvent =
	| { kind: 'status' }
	| { kind: 'log'; source: string; text: string };

export type SupervisorListener = (event: SupervisorEvent) => void;

const countsSchema = z.object({
	claimed: z.number(),
	saved: z.number(),
	failed: z.number(),
	rateLimited: z.number(),
	notFound: z.number(),
});

const metricsSchema = z.object({
	requests: z.number(),
	http429: z.number(),
	processed: z.number(),
	failed: z.number(),
	pauseMs: z.number(),
	idle: z.boolean().optional(),
});

/** What a DB service sends over IPC. */
const dbMessageSchema = z.object({ type: z.literal('ready'), url: z.string() });

/** What a crawler sends over IPC. */
const crawlerMessageSchema = z.discriminatedUnion('type', [
	z.object({ type: z.literal('started') }),
	z.object({ type: z.literal('progress'), counts: countsSchema }),
	z.object({ type: z.literal('metrics'), metrics: metricsSchema }),
	z.object({ type: z.literal('stopped'), counts: countsSchema, error: z.string().optional() }),
]);

const DEFAULT_READY_TIMEOUT_MS = 30_000;
const DEFAULT_STOP_TIMEOUT_MS = 10_000;
const DEFAULT_LOG_LINES = 500;
const DEFAULT_DB_STATS_INTERVAL_MS = 5000;

/**
 * Starts, stops and watches the DB service and the crawlers.
 * A crawler starts only after the DB service is ready. It knows nothing about HTTP or about forking.
 */
export class Supervisor {
	private readonly db: ManagedChild;
	private readonly crawlers = new Map<string, ManagedChild>();
	private readonly readyTimeoutMs: number;
	private readonly stopTimeoutMs: number;
	private readonly logLines: number;
	private readonly listeners = new Set<SupervisorListener>();
	private readonly dbStatsSource: DbStatsSource;
	private readonly dbStatsIntervalMs: number;
	private dbToken?: string;
	private dbStats?: DbStats;
	private dbStatsError?: string;
	private dbStatsTimer?: NodeJS.Timeout;
	private dbStatsReading = false;

	constructor(private readonly options: SupervisorOptions) {
		this.readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
		this.stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
		this.logLines = options.logLines ?? DEFAULT_LOG_LINES;
		// the DB service stops on SIGTERM
		this.db = new ManagedChild(options.launcher, { signal: 'SIGTERM' }, this.stopTimeoutMs, this.logLines);
		this.watch(this.db, 'db');
		this.dbStatsSource = options.dbStatsSource ?? new HttpDbStatsSource();
		this.dbStatsIntervalMs = options.dbStatsIntervalMs ?? DEFAULT_DB_STATS_INTERVAL_MS;
		const notify = this.db.onChange;
		this.db.onChange = () => {
			notify?.();
			this.syncDbStatsReading();
		};
	}

	/** Calls the listener when a state, the counts or the output of any child change. Returns a function that stops it. */
	subscribe(listener: SupervisorListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async status(): Promise<SupervisorStatus> {
		const config = await this.options.configStore.load();
		const names = config.crawlers.map(crawler => crawler.name);
		const configured = new Set(names);
		// a crawler that left the config but still runs stays visible
		const extra = [...this.crawlers.keys()].filter(name => !configured.has(name) && this.crawlers.get(name)?.isActive);
		return {
			db: { ...this.db.status(), dbStats: this.dbStats, dbStatsError: this.dbStatsError },
			crawlers: [...names, ...extra].map(name => ({
				name,
				configured: configured.has(name),
				...(this.crawlers.get(name)?.status() ?? { state: 'stopped' as const }),
			})),
		};
	}

	dbLogs(limit?: number): string[] {
		return this.db.logs.snapshot(limit);
	}

	crawlerLogs(name: string, limit?: number): string[] {
		const child = this.crawlers.get(name);
		if (!child) {
			throw notFound(`No crawler ${name} has run yet`);
		}
		return child.logs.snapshot(limit);
	}

	async startDb(): Promise<void> {
		const { dbService } = await this.options.configStore.load();
		this.dbToken = dbService.token;
		this.db.begin();
		this.db.launch({
			entry: this.options.entries.dbService,
			env: {
				DB_SERVICE_HOST: '127.0.0.1',
				DB_SERVICE_PORT: String(dbService.port),
				DB_SERVICE_TOKEN: dbService.token,
				DB_SERVICE_LEASE_MS: dbService.leaseMs === undefined ? undefined : String(dbService.leaseMs),
				BAND_DB_PATH: dbService.dbFile,
			},
		}, (child, message) => {
			const ready = dbMessageSchema.safeParse(message);
			if (ready.success) {
				child.url = ready.data.url;
				child.markRunning();
				logger.info(logMessage(LogSource.Main, `DB service is ready: ${ready.data.url}`));
			}
		});
	}

	/** Stops the crawlers first, because they cannot work without the DB service. */
	async stopDb(): Promise<void> {
		await Promise.all([...this.crawlers.values()].map(crawler => crawler.stop()));
		await this.db.stop();
	}

	/** The crawlers are not stopped. They retry for a while until the new service is up. */
	async restartDb(): Promise<void> {
		await this.db.stop();
		await this.startDb();
	}

	async startCrawler(name: string): Promise<void> {
		const config = await this.options.configStore.load();
		const setting = config.crawlers.find(crawler => crawler.name === name);
		if (!setting) {
			throw notFound(`No crawler ${name} in the config`);
		}

		let child = this.crawlers.get(name);
		if (!child) {
			// a crawler stops on an IPC message
			child = new ManagedChild(this.options.launcher, { message: { type: 'stop' } }, this.stopTimeoutMs, this.logLines);
			child.metrics = new CrawlerMetricsTracker(this.options.now);
			this.crawlers.set(name, child);
			this.watch(child, `crawler:${name}`);
		}
		// marked before the wait, so a second start is refused
		child.begin();

		let proxyUrl: string | undefined;
		try {
			proxyUrl = await this.resolveProxy(setting, config);
		} catch (error) {
			child.fail((error as Error).message);
			throw error;
		}
		try {
			await this.ensureDbReady();
		} catch (error) {
			const message = `DB service is not ready: ${(error as Error).message}`;
			child.fail(message);
			throw error instanceof AdminError ? error : new AdminError(message, 503);
		}
		if (child.state !== 'starting') {
			// it was stopped while it waited
			return;
		}

		child.launch({
			entry: this.options.entries.crawler,
			// no DB URL in the environment: the config message below gives it
			env: { CRAWLER_DB_URL: undefined },
		}, (self, message) => this.onCrawlerMessage(self, message));
		child.send({
			type: 'config',
			config: this.crawlerConfig(setting, proxyUrl, this.db.url, config.dbService.token),
		});
	}

	async stopCrawler(name: string): Promise<void> {
		const child = this.crawlers.get(name);
		if (!child) {
			throw notFound(`No crawler ${name} has run yet`);
		}
		await child.stop();
	}

	async restartCrawler(name: string): Promise<void> {
		const child = this.crawlers.get(name);
		await child?.stop();
		await this.startCrawler(name);
	}

	/** Starts the DB service, then every crawler of the config. */
	async startAll(): Promise<void> {
		const config: AdminConfig = await this.options.configStore.load();
		if (!this.db.isActive) {
			await this.startDb();
		}
		const results = await Promise.allSettled(
			config.crawlers
				.filter(crawler => !this.crawlers.get(crawler.name)?.isActive)
				.map(crawler => this.startCrawler(crawler.name)),
		);
		const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
		if (failed) {
			throw failed.reason;
		}
	}

	/** Stops every crawler, then the DB service. */
	async stopAll(): Promise<void> {
		await this.stopDb();
	}

	/** Called when the admin stops: no child is left behind. */
	async shutdown(): Promise<void> {
		await this.stopAll();
		this.stopDbStatsReading();
	}

	private async ensureDbReady(): Promise<void> {
		if (this.db.state === 'stopping') {
			throw conflict('DB service is stopping');
		}
		if (!this.db.isActive) {
			await this.startDb();
		}
		let timer: NodeJS.Timeout | undefined;
		const timeout = new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => reject(new Error('timed out')), this.readyTimeoutMs);
		});
		try {
			await Promise.race([this.db.whenRunning(), timeout]);
		} finally {
			clearTimeout(timer);
		}
	}

	/** The proxy URL of a crawler. A pool proxy is read from the config and a Webshare list proxy is looked up now, so the list is fresh at each start. */
	private async resolveProxy(setting: CrawlerSetting, config: AdminConfig): Promise<string | undefined> {
		const { proxy } = setting;
		if (proxy.kind === 'pool') {
			const entry = config.proxyPool.find(item => poolKeyOf(item) === proxy.key);
			if (!entry) {
				throw new AdminError(`Proxy ${proxy.key} of crawler ${setting.name} is not in the proxy pool`, 400);
			}
			return proxyUrlOfEntry(entry);
		}
		if (proxy.kind !== 'webshare-list') {
			return proxyUrlOf(proxy);
		}
		if (!config.webshare) {
			throw new AdminError('No Webshare API key in the config', 400);
		}
		const factory = this.options.proxyListFactory ?? (apiKey => new WebshareProxySource({ apiKey }));
		const entries = await factory(config.webshare.apiKey).list();
		return proxyUrlOfEntry(pickProxy(entries, proxy));
	}

	/** Reads the DB service counters while the service runs. */
	private syncDbStatsReading(): void {
		if (this.db.state === 'running') {
			if (!this.dbStatsTimer && this.dbStatsIntervalMs > 0) {
				this.dbStatsTimer = setInterval(() => void this.readDbStats(), this.dbStatsIntervalMs);
				// the timer must not keep the admin alive
				this.dbStatsTimer.unref();
				void this.readDbStats();
			}
		} else {
			this.stopDbStatsReading();
			this.dbStats = undefined;
			this.dbStatsError = undefined;
		}
	}

	private stopDbStatsReading(): void {
		clearInterval(this.dbStatsTimer);
		this.dbStatsTimer = undefined;
	}

	private async readDbStats(): Promise<void> {
		const url = this.db.url;
		if (!url || this.dbStatsReading) {
			return;
		}
		this.dbStatsReading = true;
		try {
			const stats = await this.dbStatsSource.read(url, this.dbToken);
			// the service may have stopped while the request was running
			if (this.db.state === 'running') {
				this.dbStats = stats;
				this.dbStatsError = undefined;
			}
		} catch (error) {
			if (this.db.state === 'running') {
				this.dbStatsError = (error as Error).message;
			}
		} finally {
			this.dbStatsReading = false;
		}
		this.emit({ kind: 'status' });
	}

	private watch(child: ManagedChild, source: string): void {
		child.onChange = () => this.emit({ kind: 'status' });
		child.onOutput = text => this.emit({ kind: 'log', source, text });
	}

	private emit(event: SupervisorEvent): void {
		this.listeners.forEach(listener => listener(event));
	}

	private onCrawlerMessage(child: ManagedChild, raw: unknown): void {
		const message = crawlerMessageSchema.safeParse(raw);
		if (!message.success) {
			return;
		}
		switch (message.data.type) {
			case 'started':
				child.markRunning();
				break;
			case 'progress':
				child.counts = message.data.counts as CrawlerCounts;
				child.notify();
				break;
			case 'metrics':
				child.metrics?.record(message.data.metrics);
				child.notify();
				break;
			case 'stopped':
				child.counts = message.data.counts as CrawlerCounts;
				child.markFinished(message.data.error);
				break;
		}
	}

	private crawlerConfig(setting: CrawlerSetting, proxyUrl: string | undefined, dbUrl: string | undefined, token: string | undefined): Record<string, unknown> {
		return {
			dbUrl,
			token,
			type: setting.type,
			reverse: setting.reverse,
			workers: setting.workers,
			minDelayMs: setting.minDelayMs,
			maxDelayMs: setting.maxDelayMs,
			idleMs: setting.idleMs,
			proxy: proxyUrl,
		};
	}
}
