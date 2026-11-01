import { setTimeout as sleep } from 'node:timers/promises';
import { errorResponseSchema } from '@band-spider/contracts';
import { errorMessage, logger, logMessage, LogSource } from '@band-spider/core';

/** How the crawler talks to the DB service. A test can replace it, the HTTP one is the real one. */
export interface CrawlTransport {
	/** Sends a JSON body to a route and returns the JSON answer. */
	post(route: string, body: unknown): Promise<unknown>;
}

/** The DB service answered, but with an error status. It is not retried. */
export class DbServiceError extends Error {
	constructor(public readonly status: number, message: string) {
		super(`DB service answered HTTP ${status}: ${message}`);
	}
}

export interface HttpCrawlTransportOptions {
	/** Sent as `Authorization: Bearer <token>`. */
	token?: string;
	/** Tries for one request when the connection fails. */
	maxAttempts?: number;
	baseDelayMs?: number;
	maxDelayMs?: number;
	timeoutMs?: number;
	/** The default is the global fetch, never a proxy: the DB service is always reached directly. */
	fetchFn?: typeof fetch;
	sleep?: (ms: number) => Promise<void>;
}

/**
 * HTTP/JSON to the DB service. A connection error (the service is down or restarts, a timeout) is
 * tried again with a growing pause. An answer with an error status is thrown at once.
 */
export class HttpCrawlTransport implements CrawlTransport {
	private readonly maxAttempts: number;
	private readonly baseDelayMs: number;
	private readonly maxDelayMs: number;
	private readonly timeoutMs: number;
	private readonly fetchFn: typeof fetch;
	private readonly sleep: (ms: number) => Promise<void>;

	constructor(
		private readonly baseUrl: string,
		private readonly options: HttpCrawlTransportOptions = {},
	) {
		this.maxAttempts = options.maxAttempts ?? 8;
		this.baseDelayMs = options.baseDelayMs ?? 500;
		this.maxDelayMs = options.maxDelayMs ?? 15_000;
		this.timeoutMs = options.timeoutMs ?? 60_000;
		// looked up on every call, so a replaced global fetch is used
		this.fetchFn = options.fetchFn ?? ((input, init) => globalThis.fetch(input, init));
		this.sleep = options.sleep ?? (ms => sleep(ms));
	}

	public async post(route: string, body: unknown): Promise<unknown> {
		for (let attempt = 1; ; attempt++) {
			let response: Response;
			try {
				response = await this.fetchFn(this.baseUrl + route, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						...(this.options.token ? { Authorization: `Bearer ${this.options.token}` } : {}),
					},
					body: JSON.stringify(body),
					signal: AbortSignal.timeout(this.timeoutMs),
				});
			} catch (error) {
				if (attempt >= this.maxAttempts) {
					throw error;
				}
				const delay = Math.min(this.baseDelayMs * 2 ** (attempt - 1), this.maxDelayMs);
				logger.warn(logMessage(LogSource.Main, `DB service is not reachable (${describeFailure(error)}), try ${attempt}/${this.maxAttempts}, next in ${delay} ms`));
				await this.sleep(delay);
				continue;
			}

			const payload: unknown = await response.json().catch((): undefined => undefined);
			if (!response.ok) {
				const parsed = errorResponseSchema.safeParse(payload);
				throw new DbServiceError(response.status, parsed.success ? parsed.data.message : response.statusText);
			}
			return payload;
		}
	}
}

/** `fetch failed` hides the real reason in `cause`. */
const describeFailure = (error: unknown): string => {
	const cause = (error as { cause?: { code?: string, message?: string } })?.cause;
	return cause?.code ?? cause?.message ?? errorMessage(error);
};
