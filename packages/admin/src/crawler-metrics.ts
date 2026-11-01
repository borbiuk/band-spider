/** What a crawler reports. The numbers count from the start of the crawler. */
export interface MetricsReport {
	requests: number;
	http429: number;
	processed: number;
	failed: number;
	/** The longest pause after a 429 that is still active, in ms. */
	pauseMs: number;
}

/** The numbers the admin shows for one crawler. */
export interface CrawlerStats {
	requestsPerMin: number;
	urlsPerMin: number;
	/** HTTP 429 answers in the last hour. */
	http429PerHour: number;
	totals: { requests: number; processed: number; failed: number; http429: number };
	pauseMs: number;
	/** Time of the last report, in ms since 1970. Undefined before the first report. */
	reportedAt?: number;
}

/** Speeds are counted over this time. */
export const SPEED_WINDOW_MS = 5 * 60_000;
export const HOUR_MS = 60 * 60_000;

interface Sample extends MetricsReport {
	at: number;
}

const ZERO: MetricsReport = { requests: 0, http429: 0, processed: 0, failed: 0, pauseMs: 0 };

/**
 * Keeps the reports of one crawler run and turns them into speeds. A report holds totals, so a
 * speed is the growth between two reports divided by the time between them. The start of the run
 * counts as a report with all zeros, so the first real report already gives a speed.
 */
export class CrawlerMetricsTracker {
	private samples: Sample[] = [];

	constructor(private readonly now: () => number = Date.now) {
	}

	/** Forgets the old run. Call it when the crawler starts. */
	reset(): void {
		this.samples = [{ ...ZERO, at: this.now() }];
	}

	record(report: MetricsReport): void {
		if (this.samples.length === 0) {
			this.reset();
		}
		const at = this.now();
		this.samples.push({ ...report, at });
		// reports older than an hour are not needed, one older sample is kept as the start of the window
		const keepFrom = at - HOUR_MS;
		while (this.samples.length > 2 && this.samples[1].at <= keepFrom) {
			this.samples.shift();
		}
	}

	/** The speeds, or undefined when the crawler has not reported yet. */
	summary(): CrawlerStats | undefined {
		if (this.samples.length < 2) {
			return undefined;
		}
		const last = this.samples[this.samples.length - 1];
		const speedBase = this.baseFor(last.at - SPEED_WINDOW_MS);
		const hourBase = this.baseFor(last.at - HOUR_MS);
		const minutes = Math.max(last.at - speedBase.at, 1) / 60_000;
		return {
			requestsPerMin: round((last.requests - speedBase.requests) / minutes),
			urlsPerMin: round((last.processed + last.failed - speedBase.processed - speedBase.failed) / minutes),
			http429PerHour: last.http429 - hourBase.http429,
			totals: { requests: last.requests, processed: last.processed, failed: last.failed, http429: last.http429 },
			pauseMs: last.pauseMs,
			reportedAt: last.at,
		};
	}

	/** The newest sample that is not newer than the given time, or the oldest one. */
	private baseFor(time: number): Sample {
		let base = this.samples[0];
		for (const sample of this.samples) {
			if (sample.at <= time) {
				base = sample;
			}
		}
		return base;
	}
}

const round = (value: number): number => Math.round(value * 10) / 10;
