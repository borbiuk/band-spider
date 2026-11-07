/** How many of the last page answers are kept. */
export const WINDOW_SIZE = 50;
/** A 404 is not trusted before this many answers are known. */
export const MIN_SAMPLES = 20;
/** A 404 is not trusted when more than this share of the last answers were 404. */
export const MAX_NOT_FOUND_SHARE = 0.3;

export interface NotFoundGuardOptions {
	windowSize?: number;
	minSamples?: number;
	maxShare?: number;
}

/** What to do with a 404. */
export enum NotFoundVerdict {
	/** Save the not-found mark. */
	Trusted,
	/** Too few answers to judge: release the URL without a mark. */
	Unknown,
	/** Too many 404s: the IP is likely blocked. Release the URL without a mark and pause. */
	Burst,
}

/**
 * Tells a real 404 from a block. When a proxy or Bandcamp blocks an IP, it can answer 404 for every
 * page. A real 404 is rare (about 5% of pages), so a 404 is trusted only while the share of 404s in
 * the last answers of the same IP is low.
 */
export class NotFoundGuard {
	private readonly windowSize: number;
	private readonly minSamples: number;
	private readonly maxShare: number;
	/** The last answers, true for a 404. */
	private readonly answers: boolean[] = [];
	private notFoundCount = 0;

	constructor(options: NotFoundGuardOptions = {}) {
		this.windowSize = options.windowSize ?? WINDOW_SIZE;
		this.minSamples = options.minSamples ?? MIN_SAMPLES;
		this.maxShare = options.maxShare ?? MAX_NOT_FOUND_SHARE;
	}

	/** A page was read. */
	public reportPage(): void {
		this.push(false);
	}

	/** Registers a 404 and says whether it can be trusted. */
	public reportNotFound(): NotFoundVerdict {
		this.push(true);
		if (this.answers.length < this.minSamples) {
			return NotFoundVerdict.Unknown;
		}
		return this.notFoundCount / this.answers.length > this.maxShare
			? NotFoundVerdict.Burst
			: NotFoundVerdict.Trusted;
	}

	private push(notFound: boolean): void {
		this.answers.push(notFound);
		if (notFound) {
			this.notFoundCount++;
		}
		if (this.answers.length > this.windowSize && this.answers.shift()) {
			this.notFoundCount--;
		}
	}
}
