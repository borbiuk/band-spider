import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HttpClient } from '../common/http-client';
import { RateLimitedError, RateLimitGate } from '../common/rate-limit-gate';

const createClient = (status: number) => {
	const clock = { now: 1_000_000 };
	const gate = new RateLimitGate({ now: () => clock.now, random: () => 0, sleep: async () => { } });
	const fetchFn = (async () => new Response('ok', { status, headers: { 'retry-after': '20' } })) as typeof fetch;
	const http = new HttpClient(gate, { fetchFn, minDelayMs: 0, maxDelayMs: 0, now: () => clock.now, sleep: async () => { } });
	return { http, gate, clock };
};

describe('request counters', () => {
	it('count the requests that were sent', async () => {
		const { http } = createClient(200);

		assert.equal(http.requestCount, 0);
		await http.get('https://x.bandcamp.com/a');
		await http.get('https://x.bandcamp.com/b');

		assert.equal(http.requestCount, 2);
		assert.equal(http.rateLimitedCount, 0);
		assert.equal(http.pauseLeftMs, 0);
	});

	it('count 429 answers and show the pause that is left', async () => {
		const { http, clock } = createClient(429);

		await assert.rejects(http.get('https://x.bandcamp.com/a'), RateLimitedError);

		assert.equal(http.requestCount, 1);
		assert.equal(http.rateLimitedCount, 1);
		assert.equal(http.pauseLeftMs, 20_000);
		clock.now += 5_000;
		assert.equal(http.pauseLeftMs, 15_000);
		clock.now += 20_000;
		assert.equal(http.pauseLeftMs, 0);
	});
});
