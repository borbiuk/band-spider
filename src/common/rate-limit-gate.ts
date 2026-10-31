/** First pause after a 429 when the server sends no `Retry-After`. Doubles on every next 429. */
export const BASE_PAUSE_MS = 30_000;
/** No pause is longer than this, also when `Retry-After` asks for more. */
export const MAX_PAUSE_MS = 15 * 60_000;
/** Random extra time added to a pause, as a share of the pause. */
export const JITTER_RATIO = 0.1;

export interface RateLimitGateOptions {
	basePauseMs?: number;
	maxPauseMs?: number;
	jitterRatio?: number;
	/** Current time in ms. */
	now?: () => number;
	/** Resolves after the given time in ms. */
	sleep?: (ms: number) => Promise<void>;
	/** Number in [0, 1). */
	random?: () => number;
}

export interface PauseInfo {
	/** False when a pause was already active and was not extended. */
	started: boolean;
	/** Time of the pause end in ms. */
	until: number;
	/** Length of the active pause counted from now in ms. */
	pauseMs: number;
	/** How many 429 pauses in a row were started, including this one. */
	level: number;
}

/** Thrown by page readers when the server answered HTTP 429, so the item is not counted as failed. */
export class RateLimitedError extends Error {
	constructor(
		public readonly url: string,
		/** Raw `Retry-After` header value, if any. */
		public readonly retryAfter?: string,
	) {
		super(`HTTP 429 Too Many Requests: ${url}`);
		this.name = 'RateLimitedError';
	}
}

/**
 * Reads `Retry-After`, which is either a number of seconds or an HTTP date.
 *
 * @returns The wait in ms, or null when the value is missing or not valid.
 */
export function parseRetryAfter(value: string | undefined | null, now: number): number | null {
	if (value === undefined || value === null) {
		return null;
	}

	const text = value.trim();
	if (/^\d+(\.\d+)?$/.test(text)) {
		return Number(text) * 1000;
	}

	const date = Date.parse(text);
	return isNaN(date) ? null : Math.max(0, date - now);
}

/** One pause shared by all workers: after a 429 every worker waits before it takes the next URL. */
export class RateLimitGate {
	private readonly basePauseMs: number;
	private readonly maxPauseMs: number;
	private readonly jitterRatio: number;
	private readonly now: () => number;
	private readonly sleep: (ms: number) => Promise<void>;
	private readonly random: () => number;

	private pausedUntil = 0;
	private level = 0;

	constructor(options: RateLimitGateOptions = {}) {
		this.basePauseMs = options.basePauseMs ?? BASE_PAUSE_MS;
		this.maxPauseMs = options.maxPauseMs ?? MAX_PAUSE_MS;
		this.jitterRatio = options.jitterRatio ?? JITTER_RATIO;
		this.now = options.now ?? Date.now;
		this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
		this.random = options.random ?? Math.random;
	}

	public get isPaused(): boolean {
		return this.now() < this.pausedUntil;
	}

	/**
	 * Registers a 429. While a pause is active it is only made longer, never shorter, and the
	 * backoff level does not grow, so a burst of 429s counts as one.
	 */
	public trip(retryAfter?: string | null): PauseInfo {
		const now = this.now();
		const fromHeader = parseRetryAfter(retryAfter, now);

		if (now < this.pausedUntil) {
			if (fromHeader !== null) {
				this.pausedUntil = Math.max(this.pausedUntil, now + this.withJitter(fromHeader));
			}
			return { started: false, until: this.pausedUntil, pauseMs: this.pausedUntil - now, level: this.level };
		}

		const backoff = this.basePauseMs * 2 ** this.level;
		this.level++;
		this.pausedUntil = now + this.withJitter(fromHeader ?? backoff);
		return { started: true, until: this.pausedUntil, pauseMs: this.pausedUntil - now, level: this.level };
	}

	/** A page loaded without 429: the next 429 starts from the first pause again. */
	public reportSuccess(): void {
		if (!this.isPaused) {
			this.level = 0;
		}
	}

	/** Resolves when no pause is active. A pause that grows while waiting is waited out too. */
	public async wait(): Promise<void> {
		while (true) {
			const left = this.pausedUntil - this.now();
			if (left <= 0) {
				return;
			}
			await this.sleep(left);
		}
	}

	private withJitter(ms: number): number {
		const capped = Math.min(ms, this.maxPauseMs);
		return Math.min(capped + capped * this.jitterRatio * this.random(), this.maxPauseMs);
	}
}
