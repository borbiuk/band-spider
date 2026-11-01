import { setTimeout as sleep } from 'node:timers/promises';
import { HttpStatusError, PageNotFoundError } from './errors';
import { NoProxy, ProxySource } from './proxy-source';
import { RateLimitedError, RateLimitGate } from './rate-limit-gate';

/** The pause between two requests is a random time between these two values. */
export const MIN_REQUEST_DELAY_MS = 400;
export const MAX_REQUEST_DELAY_MS = 450;

/** A request that takes longer is cancelled and counted as a normal failure. */
export const REQUEST_TIMEOUT_MS = 30_000;

/** Headers of a regular browser. No cookies are sent. */
export const BROWSER_HEADERS: Readonly<Record<string, string>> = {
	'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
	'Accept-Language': 'en-US,en;q=0.9',
};

export interface HttpResponse {
	status: number;
	body: string;
}

export interface HttpClientOptions {
	minDelayMs?: number;
	maxDelayMs?: number;
	timeoutMs?: number;
	/** Called when the server answers HTTP 429, before the error is thrown. Must start the pause of this client's gate; the default does only that. */
	onRateLimited?: (url: string, retryAfter?: string) => void;
	/** Where requests leave from. The default is the local IP. */
	proxySource?: ProxySource;
	/** Replaces the fetch function of the proxy source. */
	fetchFn?: typeof fetch;
	/** Resolves after the given time in ms. */
	sleep?: (ms: number) => Promise<void>;
	/** Number in [0, 1). */
	random?: () => number;
	/** Current time in ms. */
	now?: () => number;
}

/**
 * Plain HTTP requests for the page readers. Every request waits while the pause after
 * HTTP 429 is active, keeps a random minimum distance from the start of the previous request (the slot is reserved before the request, so it holds for any number of callers), and turns a 429
 * answer into `RateLimitedError`. Other statuses are returned as they are.
 */
export class HttpClient {
	private readonly minDelayMs: number;
	private readonly maxDelayMs: number;
	private readonly timeoutMs: number;
	private readonly onRateLimited: (url: string, retryAfter?: string) => void;
	private readonly fetchFn: typeof fetch;
	private readonly sleep: (ms: number) => Promise<void>;
	private readonly random: () => number;
	private readonly now: () => number;

	/** Earliest start of the next request. */
	private nextRequestAt = 0;

	constructor(
		private readonly gate: RateLimitGate,
		options: HttpClientOptions = {},
	) {
		this.minDelayMs = options.minDelayMs ?? MIN_REQUEST_DELAY_MS;
		this.maxDelayMs = options.maxDelayMs ?? MAX_REQUEST_DELAY_MS;
		this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
		this.onRateLimited = options.onRateLimited ?? ((_url, retryAfter) => { this.gate.trip(retryAfter); });
		this.fetchFn = options.fetchFn ?? (options.proxySource ?? new NoProxy()).fetchFn;
		this.sleep = options.sleep ?? (ms => sleep(ms));
		this.random = options.random ?? Math.random;
		this.now = options.now ?? Date.now;
	}

	public get(url: string): Promise<HttpResponse> {
		return this.request(url, { method: 'GET', headers: { ...BROWSER_HEADERS, Accept: 'text/html,application/xhtml+xml' } });
	}

	public postJson(url: string, body: unknown): Promise<HttpResponse> {
		return this.request(url, {
			method: 'POST',
			headers: { ...BROWSER_HEADERS, Accept: 'application/json', 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});
	}

	private async request(url: string, init: RequestInit): Promise<HttpResponse> {
		// wait for the pause after a 429, then reserve the next request slot before sending
		while (true) {
			await this.gate.wait();
			const now = this.now();
			const start = Math.max(now, this.nextRequestAt);
			this.nextRequestAt = start + this.minDelayMs + this.random() * (this.maxDelayMs - this.minDelayMs);
			if (start > now) {
				await this.sleep(start - now);
			}
			if (!this.gate.isPaused) {
				break;
			}
		}

		try {
			const response = await this.fetchFn(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });

			if (response.status === 429) {
				const retryAfter = response.headers.get('retry-after') ?? undefined;
				await response.body?.cancel().catch(() => { });
				this.onRateLimited(url, retryAfter);
				throw new RateLimitedError(url, retryAfter);
			}

			return { status: response.status, body: await response.text() };
		} catch (e) {
			throw withNetworkCode(e, url);
		}
	}
}

/**
 * `fetch` and `text()` report a network failure as `TypeError: fetch failed` (or `terminated`) and
 * keep the real reason in `cause`. Such an error is replaced with one that names the reason's code
 * (or its message when it has no code) and the URL, so the log line says what went wrong. Other
 * errors (timeout, 429) stay as they are.
 */
function withNetworkCode(error: unknown, url: string): unknown {
	if (!(error instanceof TypeError) || error.cause === undefined) {
		return error;
	}

	const cause = error.cause as { code?: string, message?: string };
	return new Error(`Request failed (${cause.code ?? cause.message ?? 'unknown'}): ${url}`, { cause: error });
}

/**
 * Loads a page and returns its HTML.
 *
 * @throws `PageNotFoundError` for HTTP 404, `RateLimitedError` for HTTP 429, `HttpStatusError` for
 * any other status that is not 200.
 */
export async function getPageHtml(http: HttpClient, url: string): Promise<string> {
	const response = await http.get(url);
	if (response.status === 404) {
		throw new PageNotFoundError();
	}
	if (response.status !== 200) {
		throw new HttpStatusError(response.status, url);
	}
	return response.body;
}
