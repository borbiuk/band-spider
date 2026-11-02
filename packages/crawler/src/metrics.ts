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
	/** Bytes sent to the proxy. Still compressed, as the proxy bills them. 0 without a proxy. */
	bytesSent: number;
	/** Bytes received from the proxy. Still compressed, as the proxy bills them. 0 without a proxy. */
	bytesReceived: number;
	/** New links between an item and an account that the saved pages added to the DB. */
	newLinks: number;
	/** The longest pause after a 429 that is still active, over all clients, in ms. */
	pauseMs: number;
	/** True while the crawler waits for new URLs. */
	idle: boolean;
}

/** What the crawler reads from an HTTP client. HttpClient has these. */
export interface RequestMeter {
	readonly requestCount: number;
	readonly rateLimitedCount: number;
	readonly pauseLeftMs: number;
	readonly trafficBytes?: { readonly sent: number; readonly received: number };
}

/** Puts the numbers of all clients and the URL counts together. */
export const collectMetrics = (meters: readonly RequestMeter[], counts: CrawlerCounts, idle = false, newLinks = 0): CrawlerMetrics => ({
	requests: meters.reduce((sum, meter) => sum + meter.requestCount, 0),
	http429: meters.reduce((sum, meter) => sum + meter.rateLimitedCount, 0),
	processed: counts.saved,
	failed: counts.failed + counts.notFound,
	bytesSent: meters.reduce((sum, meter) => sum + (meter.trafficBytes?.sent ?? 0), 0),
	bytesReceived: meters.reduce((sum, meter) => sum + (meter.trafficBytes?.received ?? 0), 0),
	newLinks,
	pauseMs: meters.reduce((longest, meter) => Math.max(longest, meter.pauseLeftMs), 0),
	idle,
});
