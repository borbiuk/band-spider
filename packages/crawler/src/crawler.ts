import {
	BandSpider,
	BandSpiderOptions,
	errorMessage,
	HttpClient,
	logger,
	logMessage,
	LogSource,
	MAX_REQUEST_DELAY_MS,
	MIN_REQUEST_DELAY_MS,
	PageReader,
	UrlType,
} from '@band-spider/core';
import { CrawlerConfig } from './config';
import { CountingCrawlStore, CrawlerCounts } from './counting-crawl-store';
import { CrawlTransport, HttpCrawlTransport } from './crawl-transport';
import { RemoteCrawlStore } from './remote-crawl-store';

/** What a crawler tells its parent. */
export type CrawlerEvent =
	| { type: 'started' }
	| { type: 'progress', counts: CrawlerCounts }
	/** `error` is set when the crawler stopped because of a failure. */
	| { type: 'stopped', counts: CrawlerCounts, error?: string };

export interface CrawlerDeps {
	/** When aborted, every worker stops after its current URL, and the URLs not done are released. */
	signal?: AbortSignal;
	onEvent?: (event: CrawlerEvent) => void;
	/** Replaces the transport to the DB service. */
	transport?: CrawlTransport;
	/** Replaces the page reader of a worker. A test passes a fake one. */
	createReader?: (http: HttpClient) => PageReader;
	/** The least time between two progress events. */
	progressIntervalMs?: number;
}

/** How the BandSpider options come from the crawler config. */
export const toSpiderOptions = (config: CrawlerConfig): BandSpiderOptions => {
	const minDelayMs = config.minDelayMs ?? Math.min(MIN_REQUEST_DELAY_MS, config.maxDelayMs ?? MIN_REQUEST_DELAY_MS);
	const maxDelayMs = config.maxDelayMs ?? Math.max(MAX_REQUEST_DELAY_MS, minDelayMs);
	return {
		concurrency: config.workers,
		type: config.type as UrlType,
		superTag: false,
		reverse: config.reverse,
		minDelayMs,
		maxDelayMs,
		...(config.proxy !== undefined ? { proxy: config.proxy } : {}),
	};
};

/**
 * The composition root of a crawler: wires the remote store, the counters and the spider.
 * It resolves with the counts when the workers have stopped, because the signal was aborted or
 * because there are no URLs left. The proxy is only given to the spider, the transport to the DB
 * service never uses it.
 */
export const runCrawler = async (config: CrawlerConfig, deps: CrawlerDeps = {}): Promise<CrawlerCounts> => {
	const { signal, onEvent = () => { }, progressIntervalMs = 1000 } = deps;

	let lastProgress = 0;
	const remote = new RemoteCrawlStore(deps.transport ?? new HttpCrawlTransport(config.dbUrl, { token: config.token }));
	const store = new CountingCrawlStore(remote, counts => {
		const now = Date.now();
		if (now - lastProgress >= progressIntervalMs) {
			lastProgress = now;
			onEvent({ type: 'progress', counts });
		}
	});

	logger.info(logMessage(LogSource.Main, `Crawler started: ${config.type}, ${config.workers} worker(s), ${config.proxy === undefined ? 'local IP' : 'proxy'}`));
	onEvent({ type: 'started' });

	try {
		await new BandSpider(store, deps.createReader).run(toSpiderOptions(config), signal);
		onEvent({ type: 'stopped', counts: { ...store.counts } });
		return store.counts;
	} catch (error) {
		onEvent({ type: 'stopped', counts: { ...store.counts }, error: errorMessage(error) });
		throw error;
	} finally {
		remote.close();
	}
};
