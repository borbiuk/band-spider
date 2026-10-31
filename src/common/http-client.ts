import { HttpStatusError, PageNotFoundError } from './errors';
import { RateLimitedError, RateLimitGate } from './rate-limit-gate';

/** The pause between two requests is a random time between these two values. */
export const MIN_REQUEST_DELAY_MS = 500;
export const MAX_REQUEST_DELAY_MS = 1_500;

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
	/** Called when the server answers HTTP 429, before the error is thrown. Must start the shared pause; the default does only that. */
	onRateLimited?: (url: string, retryAfter?: string) => void;
	fetchFn?: typeof fetch;
	/** Resolves after the given time in ms. */
	sleep?: (ms: number) => Promise<void>;
	/** Number in [0, 1). */
	random?: () => number;
	/** Current time in ms. */
	now?: () => number;
}

/**
 * Plain HTTP requests for the page readers. Every request waits while the shared pause after
 * HTTP 429 is active, keeps a random minimum distance from the previous request, and turns a 429
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

	private nextRequestAt = 0;

	constructor(
		private readonly gate: RateLimitGate,
		options: HttpClientOptions = {},
	) {
		this.minDelayMs = options.minDelayMs ?? MIN_REQUEST_DELAY_MS;
		this.maxDelayMs = options.maxDelayMs ?? MAX_REQUEST_DELAY_MS;
		this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
		this.onRateLimited = options.onRateLimited ?? ((_url, retryAfter) => { this.gate.trip(retryAfter); });
		this.fetchFn = options.fetchFn ?? fetch;
		this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
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
		// wait for the pause after a 429 and for the minimum distance to the previous request
		do {
			await this.gate.wait();
			const left = this.nextRequestAt - this.now();
			if (left > 0) {
				await this.sleep(left);
			}
		} while (this.gate.isPaused);

		try {
			const response = await this.fetchFn(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });

			if (response.status === 429) {
				const retryAfter = response.headers.get('retry-after') ?? undefined;
				await response.body?.cancel().catch(() => { });
				this.onRateLimited(url, retryAfter);
				throw new RateLimitedError(url, retryAfter);
			}

			return { status: response.status, body: await response.text() };
		} finally {
			this.nextRequestAt = this.now() + this.minDelayMs + this.random() * (this.maxDelayMs - this.minDelayMs);
		}
	}
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
