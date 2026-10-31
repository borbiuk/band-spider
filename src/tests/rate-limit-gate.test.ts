import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	BASE_PAUSE_MS,
	JITTER_RATIO,
	MAX_PAUSE_MS,
	parseRetryAfter,
	RateLimitedError,
	RateLimitGate,
} from '../common/rate-limit-gate';
import { MAX_REQUEST_DELAY_MS, MIN_REQUEST_DELAY_MS, REQUEST_TIMEOUT_MS } from '../common/http-client';

/** A gate on a fake clock. `random` is fixed, `sleep` moves the clock. */
const createGate = (random = 0) => {
	const clock = { now: 1_000_000 };
	const sleeps: number[] = [];
	const gate = new RateLimitGate({
		now: () => clock.now,
		random: () => random,
		sleep: async ms => { sleeps.push(ms); clock.now += ms; },
	});
	return { gate, clock, sleeps };
};

describe('rate limit constants', () => {
	it('keeps the pause and request timing values', () => {
		assert.equal(BASE_PAUSE_MS, 30_000);
		assert.equal(MAX_PAUSE_MS, 900_000);
		assert.equal(JITTER_RATIO, 0.1);
		assert.equal(MIN_REQUEST_DELAY_MS, 500);
		assert.equal(MAX_REQUEST_DELAY_MS, 1_500);
		assert.equal(REQUEST_TIMEOUT_MS, 30_000);
	});
});

describe('parseRetryAfter', () => {
	const now = Date.parse('2026-01-01T00:00:00Z');

	it('reads seconds', () => {
		assert.equal(parseRetryAfter('42', now), 42_000);
		assert.equal(parseRetryAfter(' 1.5 ', now), 1_500);
		assert.equal(parseRetryAfter('0', now), 0);
	});

	it('reads an HTTP date and never goes below zero', () => {
		assert.equal(parseRetryAfter('Thu, 01 Jan 2026 00:01:00 GMT', now), 60_000);
		assert.equal(parseRetryAfter('Wed, 31 Dec 2025 23:00:00 GMT', now), 0);
	});

	it('returns null for missing or invalid values', () => {
		assert.equal(parseRetryAfter(undefined, now), null);
		assert.equal(parseRetryAfter(null, now), null);
		assert.equal(parseRetryAfter('soon', now), null);
	});

	it('reads "-5" as a date in the past, so the wait is zero', () => {
		// Date.parse accepts "-5" as a year; this pins the current behavior
		assert.equal(parseRetryAfter('-5', now), 0);
	});
});

describe('RateLimitGate', () => {
	it('doubles the pause for every 429 in a row and caps it', () => {
		const { gate, clock } = createGate();
		const pauses: number[] = [];

		for (let i = 0; i < 7; i++) {
			const info = gate.trip();
			assert.equal(info.started, true);
			assert.equal(info.level, i + 1);
			pauses.push(info.pauseMs);
			clock.now = info.until;
		}

		assert.deepEqual(pauses, [30_000, 60_000, 120_000, 240_000, 480_000, 900_000, 900_000]);
	});

	it('adds jitter as a share of the pause, within the cap', () => {
		assert.equal(createGate(0.5).gate.trip().pauseMs, 30_000 + 30_000 * 0.1 * 0.5);
		assert.equal(createGate(0.999).gate.trip('10').pauseMs, 10_000 + 10_000 * 0.1 * 0.999);
		assert.equal(createGate(0.999).gate.trip('899').pauseMs, MAX_PAUSE_MS, 'jitter never goes over the cap');
	});

	it('uses Retry-After instead of the backoff, capped at the maximum', () => {
		assert.equal(createGate().gate.trip('42').pauseMs, 42_000);
		assert.equal(createGate().gate.trip('3600').pauseMs, MAX_PAUSE_MS);
	});

	it('counts a burst of 429s as one and only makes the pause longer', () => {
		const { gate, clock } = createGate();

		const first = gate.trip('60');
		clock.now += 10_000;
		const shorter = gate.trip('5');
		const noHeader = gate.trip();
		const longer = gate.trip('120');

		assert.equal(first.started, true);
		assert.deepEqual([shorter.started, shorter.level, shorter.until], [false, 1, first.until]);
		assert.deepEqual([noHeader.started, noHeader.level, noHeader.until], [false, 1, first.until]);
		assert.deepEqual([longer.started, longer.level, longer.until], [false, 1, clock.now + 120_000]);
	});

	it('starts from the first pause again after a success outside a pause', () => {
		const { gate, clock } = createGate();

		clock.now = gate.trip().until;
		gate.reportSuccess();
		assert.equal(gate.trip().pauseMs, 30_000);
	});

	it('ignores a success while a pause is active', () => {
		const { gate, clock } = createGate();

		gate.trip();
		gate.reportSuccess();
		clock.now += 30_000;
		assert.equal(gate.trip().pauseMs, 60_000);
	});

	it('wait resolves at once without a pause and waits out a pause', async () => {
		const { gate, clock, sleeps } = createGate();

		await gate.wait();
		assert.deepEqual(sleeps, []);
		assert.equal(gate.isPaused, false);

		gate.trip('5');
		assert.equal(gate.isPaused, true);
		clock.now += 2_000;
		await gate.wait();
		assert.deepEqual(sleeps, [3_000]);
		assert.equal(gate.isPaused, false);
	});

	it('RateLimitedError carries the URL and the header', () => {
		const error = new RateLimitedError('https://x.bandcamp.com/a', '7');

		assert.ok(error instanceof Error);
		assert.equal(error.name, 'RateLimitedError');
		assert.equal(error.message, 'HTTP 429 Too Many Requests: https://x.bandcamp.com/a');
		assert.equal(error.url, 'https://x.bandcamp.com/a');
		assert.equal(error.retryAfter, '7');
	});
});
