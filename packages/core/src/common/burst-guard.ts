/** How many of the last answers are kept. */
export const WINDOW_SIZE = 50;
/** A suspect answer is not trusted before this many answers are known. */
export const MIN_SAMPLES = 20;
/** A suspect answer is not trusted when more than this share of the last answers were suspect. */
export const MAX_SUSPECT_SHARE = 0.3;

export interface BurstGuardOptions {
	windowSize?: number;
	minSamples?: number;
	maxShare?: number;
}

/** What to do with a suspect answer. */
export enum BurstVerdict {
	/** The answer is rare enough to be about the URL itself: count it. */
	Trusted,
	/** Too few answers to judge: release the URL without counting it. */
	Unknown,
	/** Too many suspect answers: the IP or the proxy likely has a problem. Release the URL without counting it and pause. */
	Burst,
}

/**
 * Tells a problem of one URL from a problem of the IP. When a proxy fails or Bandcamp blocks an
 * IP, every page can get a 404 or a network error. For a single URL such an answer is rare, so it
 * is trusted only while its share in the last answers of the same IP is low.
 */
export class BurstGuard {
	private readonly windowSize: number;
	private readonly minSamples: number;
	private readonly maxShare: number;
	/** The last answers, true for a suspect one. */
	private readonly answers: boolean[] = [];
	private suspectCount = 0;

	constructor(options: BurstGuardOptions = {}) {
		this.windowSize = options.windowSize ?? WINDOW_SIZE;
		this.minSamples = options.minSamples ?? MIN_SAMPLES;
		this.maxShare = options.maxShare ?? MAX_SUSPECT_SHARE;
	}

	/** A normal answer. */
	public reportOk(): void {
		this.push(false);
	}

	/** Registers a suspect answer and says whether it can be trusted. */
	public reportSuspect(): BurstVerdict {
		this.push(true);
		if (this.answers.length < this.minSamples) {
			return BurstVerdict.Unknown;
		}
		return this.suspectCount / this.answers.length > this.maxShare
			? BurstVerdict.Burst
			: BurstVerdict.Trusted;
	}

	private push(suspect: boolean): void {
		this.answers.push(suspect);
		if (suspect) {
			this.suspectCount++;
		}
		if (this.answers.length > this.windowSize && this.answers.shift()) {
			this.suspectCount--;
		}
	}
}
