import { CrawlerCounts } from './counting-crawl-store';

/** What a crawler reports about its work. All numbers count from the start of the crawler. */
export interface CrawlerMetrics {
	/** HTTP requests sent to Bandcamp. */
	requests: number;
	/** HTTP 429 answers. */
	http429: number;
	/** URLs saved. */
	processed: number;
	/** URLs given back as failed or not found. */
	failed: number;
	/** The longest pause after a 429 that is still active, over all workers, in ms. */
	pauseMs: number;
}

/** What the crawler reads from the HTTP client of a worker. HttpClient has these. */
export interface RequestMeter {
	readonly requestCount: number;
	readonly rateLimitedCount: number;
	readonly pauseLeftMs: number;
}

/** Puts the numbers of all workers and the URL counts together. */
export const collectMetrics = (meters: readonly RequestMeter[], counts: CrawlerCounts): CrawlerMetrics => ({
	requests: meters.reduce((sum, meter) => sum + meter.requestCount, 0),
	http429: meters.reduce((sum, meter) => sum + meter.rateLimitedCount, 0),
	processed: counts.saved,
	failed: counts.failed + counts.notFound,
	pauseMs: meters.reduce((longest, meter) => Math.max(longest, meter.pauseLeftMs), 0),
});
