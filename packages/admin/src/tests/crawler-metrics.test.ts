import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CrawlerMetricsTracker, HOUR_MS, MetricsReport } from '../crawler-metrics';

const MIN = 60_000;

const report = (extra: Partial<MetricsReport> = {}): MetricsReport => ({
	requests: 0, http429: 0, processed: 0, failed: 0, pauseMs: 0, ...extra,
});

const setup = () => {
	const clock = { now: 10_000_000 };
	const tracker = new CrawlerMetricsTracker(() => clock.now);
	tracker.reset();
	return { clock, tracker };
};

describe('CrawlerMetricsTracker', () => {
	it('has no numbers before the first report', () => {
		const { tracker } = setup();
		assert.equal(tracker.summary(), undefined);
		assert.equal(new CrawlerMetricsTracker().summary(), undefined);
	});

	it('gives a speed from the first report, counted from the start of the run', () => {
		const { clock, tracker } = setup();

		clock.now += MIN;
		tracker.record(report({ requests: 120, processed: 40, failed: 20, http429: 2, pauseMs: 5000 }));

		assert.deepEqual(tracker.summary(), {
			requestsPerMin: 120,
			urlsPerMin: 60,
			http429PerHour: 2,
			bytesPerHour: 0,
			linksPerMin: 0,
			failedPerMin: 20,
			failShare: 20 / 60,
			totals: { requests: 120, processed: 40, failed: 20, http429: 2, bytes: 0, newLinks: 0 },
			pauseMs: 5000,
			idle: false,
			failures: [],
			reportedAt: clock.now,
		});
	});

	it('gives the traffic and the new links per hour and per minute', () => {
		const { clock, tracker } = setup();

		clock.now += MIN;
		tracker.record(report({ bytesSent: 10_000, bytesReceived: 590_000, newLinks: 30 }));
		clock.now += MIN;
		tracker.record(report({ bytesSent: 20_000, bytesReceived: 1_180_000, newLinks: 90 }));

		const stats = tracker.summary()!;
		// 1.2 MB in two minutes
		assert.equal(stats.bytesPerHour, 36_000_000);
		assert.equal(stats.linksPerMin, 45);
		assert.equal(stats.totals.bytes, 1_200_000);
		assert.equal(stats.totals.newLinks, 90);
	});

	it('counts the speed over the last five minutes only', () => {
		const { clock, tracker } = setup();

		// a fast first ten minutes, then a slow one
		for (let minute = 1; minute <= 10; minute++) {
			clock.now += MIN;
			tracker.record(report({ requests: minute * 100, processed: minute * 50 }));
		}
		for (let minute = 11; minute <= 15; minute++) {
			clock.now += MIN;
			tracker.record(report({ requests: 1000 + (minute - 10) * 10, processed: 500 + (minute - 10) * 5 }));
		}

		const stats = tracker.summary();
		assert.equal(stats?.requestsPerMin, 10);
		assert.equal(stats?.urlsPerMin, 5);
		assert.equal(stats?.totals.requests, 1050);
	});

	it('counts the HTTP 429 answers of the last hour', () => {
		const { clock, tracker } = setup();

		clock.now += MIN;
		tracker.record(report({ http429: 4 }));
		// two quiet hours, then three more answers
		clock.now += 2 * HOUR_MS;
		tracker.record(report({ http429: 4 }));
		clock.now += 10 * MIN;
		tracker.record(report({ http429: 7 }));

		assert.equal(tracker.summary()?.http429PerHour, 3);
		assert.equal(tracker.summary()?.totals.http429, 7);
	});

	it('keeps only a bounded history', () => {
		const { clock, tracker } = setup();
		for (let index = 1; index <= 500; index++) {
			clock.now += MIN;
			tracker.record(report({ requests: index }));
		}

		// 500 minutes of reports, about an hour of them is kept
		assert.ok((tracker as unknown as { samples: unknown[] }).samples.length <= 63);
		assert.equal(tracker.summary()?.requestsPerMin, 1);
	});

	it('forgets the old run on reset', () => {
		const { clock, tracker } = setup();
		clock.now += MIN;
		tracker.record(report({ requests: 50 }));

		tracker.reset();

		assert.equal(tracker.summary(), undefined);
		clock.now += MIN;
		tracker.record(report({ requests: 6 }));
		assert.equal(tracker.summary()?.requestsPerMin, 6);
	});

	it('gives per-minute series for the charts', () => {
		const { clock, tracker } = setup();
		assert.equal(tracker.series(), undefined);

		clock.now += MIN;
		tracker.record(report({ requests: 60, processed: 20, failed: 10, http429: 1, newLinks: 5, bytesSent: 100, bytesReceived: 900 }));
		clock.now += MIN;
		tracker.record(report({ requests: 180, processed: 50, failed: 10, http429: 1, newLinks: 25, bytesSent: 200, bytesReceived: 2800 }));

		const series = tracker.series();
		assert.equal(series?.requests.length, 30);
		// the last two minutes are the only ones with work
		assert.deepEqual(series?.requests.slice(-3), [0, 60, 120]);
		assert.deepEqual(series?.urls.slice(-3), [0, 30, 30]);
		assert.deepEqual(series?.http429.slice(-3), [0, 1, 0]);
		assert.deepEqual(series?.failed.slice(-3), [0, 10, 0]);
		assert.deepEqual(series?.links.slice(-3), [0, 5, 20]);
		assert.deepEqual(series?.bytes.slice(-3), [0, 1000, 2000]);
		assert.equal(series?.requests.slice(0, 27).every(value => value === 0), true);
	});

	it('gives the failure reasons of the last report, the most frequent first', () => {
		const { clock, tracker } = setup();
		clock.now += MIN;
		tracker.record(report({
			failures: { timeout: { count: 2, last: 'a' }, 'http:503': { count: 9, last: 'b' } },
		}));
		assert.deepEqual(tracker.summary()?.failures, [
			{ key: 'http:503', count: 9, last: 'b' },
			{ key: 'timeout', count: 2, last: 'a' },
		]);
	});
});
