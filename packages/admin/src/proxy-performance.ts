import { PoolItem } from './proxy-pool';
import { CrawlerStatus } from './supervisor';
import { BAD_429_PER_HOUR, FAILING_SHARE } from './ui-parts';

/**
 * What to do with a proxy:
 * best: among the fastest and healthy. ok: fine. slow: much slower than the others, check it.
 * replace: it does not work (blocked, rate limited, warning). idle: its crawler is not running.
 * learning: too little data yet. free: no crawler uses it.
 */
export type ProxyVerdict = 'best' | 'ok' | 'slow' | 'replace' | 'idle' | 'learning' | 'free';

export interface ProxyPerf {
	verdict: ProxyVerdict;
	/** Why, in one short sentence. It is the tooltip of the verdict. */
	reason: string;
	/** Saved pages per minute: the useful speed of the proxy. Undefined when the proxy has no data. */
	savedPerMin?: number;
	requestsPerMin?: number;
	/** Share of the latest URLs that were saved, 0-100. */
	successPercent?: number;
	http429PerHour: number;
	bytesPerHour: number;
	bytesTotal: number;
	/** Traffic for 1,000 saved pages. Lower is better. */
	bytesPer1000Pages?: number;
	/** 1 is the fastest of the proxies that have data. */
	rank?: number;
}

/** A proxy needs this many done URLs (saved or failed) before it is rated. */
export const MIN_DONE_URLS = 20;
/** A proxy is slow when it saves less than this share of the median speed. */
export const SLOW_SHARE_OF_MEDIAN = 0.5;
/** A proxy is "best" when it is in this top share of the rated proxies, and healthy. */
export const BEST_SHARE = 0.2;
/** Below this success rate (percent) a proxy is called broken. */
export const REPLACE_BELOW_SUCCESS = FAILING_SHARE * 100;
/** The medians and the ranking need this many rated proxies, else there is nothing to compare with. */
export const MIN_PEERS = 3;

const median = (values: number[]): number => {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

const round1 = (value: number): number => Math.round(value * 10) / 10;

/** The numbers of one proxy: the sum over the running crawlers that use it. */
const measure = (item: PoolItem, states: Map<string, CrawlerStatus>): ProxyPerf & { done: number; broken?: string } => {
	const users = item.usedBy.map(name => states.get(name)).filter((crawler): crawler is CrawlerStatus => crawler !== undefined);
	const reporting = users.filter(crawler => crawler.state === 'running' && crawler.stats);
	let urls = 0;
	let failed = 0;
	let requests = 0;
	let saved = 0;
	let doneTotal = 0;
	let broken: string | undefined;
	for (const crawler of reporting) {
		const stats = crawler.stats!;
		urls += stats.urlsPerMin;
		failed += stats.failedPerMin;
		requests += stats.requestsPerMin;
		saved += stats.totals.processed;
		doneTotal += stats.totals.processed + stats.totals.failed;
		if (stats.warning) {
			broken ??= `${stats.warning.message}. The proxy may not work.`;
		}
		if (stats.http429PerHour >= BAD_429_PER_HOUR) {
			broken ??= `${stats.http429PerHour} HTTP 429 answers in the last hour. It is rate limited.`;
		}
	}
	const failedCrawler = users.find(crawler => crawler.state === 'failed');
	if (failedCrawler) {
		broken ??= `The crawler ${failedCrawler.name} failed${failedCrawler.error ? `: ${failedCrawler.error}` : ''}.`;
	}
	const successPercent = urls > 0 ? Math.max(Math.round(((urls - failed) / urls) * 100), 0) : undefined;
	if (successPercent !== undefined && successPercent < REPLACE_BELOW_SUCCESS && doneTotal >= MIN_DONE_URLS) {
		broken ??= `${100 - successPercent}% of the latest URLs failed. Bandcamp may have blocked it.`;
	}
	const bytesTotal = reporting.reduce((sum, crawler) => sum + (crawler.stats?.totals.bytes ?? 0), 0);
	return {
		verdict: 'ok',
		reason: '',
		...(reporting.length ? { savedPerMin: round1(Math.max(urls - failed, 0)), requestsPerMin: round1(requests) } : {}),
		...(successPercent === undefined ? {} : { successPercent }),
		http429PerHour: reporting.reduce((sum, crawler) => sum + (crawler.stats?.http429PerHour ?? 0), 0),
		bytesPerHour: reporting.reduce((sum, crawler) => sum + (crawler.stats?.bytesPerHour ?? 0), 0),
		bytesTotal,
		...(saved > 0 && bytesTotal > 0 ? { bytesPer1000Pages: (bytesTotal / saved) * 1000 } : {}),
		done: doneTotal,
		...(broken ? { broken } : {}),
	};
};

/**
 * Rates every proxy of the pool by what its crawlers report now. The speed of a proxy also depends on the settings of its
 * crawler (workers, delay), so the numbers fit best when the crawlers are set alike. The reports start again with each
 * crawler start, so a proxy needs some minutes after a start before it is rated.
 */
export const rateProxies = (items: PoolItem[], crawlers: CrawlerStatus[]): Map<string, ProxyPerf> => {
	const states = new Map(crawlers.map(crawler => [crawler.name, crawler]));
	const result = new Map<string, ProxyPerf>();
	const rated: Array<{ key: string; perf: ProxyPerf }> = [];

	for (const item of items) {
		const { done, broken, ...perf } = measure(item, states);
		const running = item.usedBy.some(name => states.get(name)?.state === 'running');
		if (item.usedBy.length === 0) {
			result.set(item.key, { ...perf, verdict: 'free', reason: 'No crawler uses this proxy.' });
		} else if (broken) {
			result.set(item.key, { ...perf, verdict: 'replace', reason: broken });
		} else if (!running) {
			result.set(item.key, { ...perf, verdict: 'idle', reason: 'The crawler of this proxy is not running.' });
		} else if (done < MIN_DONE_URLS) {
			result.set(item.key, { ...perf, verdict: 'learning', reason: `Collecting data: ${done} of ${MIN_DONE_URLS} URLs done.` });
		} else {
			rated.push({ key: item.key, perf });
		}
	}

	// the rank is the place by useful speed among the proxies that have enough data
	rated.sort((a, b) => (b.perf.savedPerMin ?? 0) - (a.perf.savedPerMin ?? 0));
	const speeds = rated.map(entry => entry.perf.savedPerMin ?? 0);
	const middle = speeds.length >= MIN_PEERS ? median(speeds) : undefined;
	const bestCount = Math.max(Math.ceil(rated.length * BEST_SHARE), 1);
	rated.forEach(({ key, perf }, index) => {
		const speed = perf.savedPerMin ?? 0;
		const rank = index + 1;
		if (middle === undefined) {
			result.set(key, { ...perf, rank, verdict: 'ok', reason: 'Too few proxies with data to compare. Looks healthy.' });
		} else if (middle > 0 && speed < middle * SLOW_SHARE_OF_MEDIAN) {
			result.set(key, { ...perf, rank, verdict: 'slow', reason: `${speed}/min is less than half of the median ${round1(middle)}/min. Check the proxy or the crawler settings.` });
		} else if (index < bestCount && (perf.successPercent ?? 0) >= 90) {
			result.set(key, { ...perf, rank, verdict: 'best', reason: `Place ${rank} of ${rated.length}: ${speed} saved pages/min, ${perf.successPercent}% success.` });
		} else {
			result.set(key, { ...perf, rank, verdict: 'ok', reason: `Place ${rank} of ${rated.length}: ${speed} saved pages/min.` });
		}
	});
	return result;
};
