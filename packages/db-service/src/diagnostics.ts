import { monitorEventLoopDelay } from 'node:perf_hooks';
import { logger, logMessage, LogSource } from '@band-spider/core';

/** A request that takes longer than this is logged. */
export const SLOW_REQUEST_MS = 1000;

/** The event loop is reported when it was blocked for longer than this in one period. */
export const BLOCKED_LOOP_MS = 500;

const REPORT_PERIOD_MS = 30_000;

/**
 * Reports when the process was blocked: SQLite runs on the one thread of the service, so a long query
 * stops every request. Returns a function that stops the report.
 */
export const startLoopMonitor = (periodMs: number = REPORT_PERIOD_MS): (() => void) => {
	const histogram = monitorEventLoopDelay({ resolution: 20 });
	histogram.enable();
	const timer = setInterval(() => {
		const maxMs = histogram.max / 1e6;
		if (maxMs >= BLOCKED_LOOP_MS) {
			const p99 = histogram.percentile(99) / 1e6;
			logger.warn(logMessage(LogSource.Main, `The DB service was blocked for ${Math.round(maxMs)} ms in the last ${Math.round(periodMs / 1000)} s (p99 ${Math.round(p99)} ms)`));
		}
		histogram.reset();
	}, periodMs);
	timer.unref();
	return () => {
		clearInterval(timer);
		histogram.disable();
	};
};

/** Logs a request that was slow, with how long it waited and how many requests were open. */
export const logSlowRequest = (method: string, url: string, tookMs: number, open: number): void => {
	if (tookMs >= SLOW_REQUEST_MS) {
		logger.warn(logMessage(LogSource.Main, `Slow request ${method} ${url}: ${Math.round(tookMs)} ms, ${open} open`));
	}
};
