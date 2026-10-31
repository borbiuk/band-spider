import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { ApiRefusedError, HttpStatusError, PageNotFoundError } from '../common/errors';
import { HttpClient } from '../common/http-client';
import { RateLimitedError, RateLimitGate } from '../common/rate-limit-gate';
import { readAccountPageByFetch } from '../core/account/clients/account-fetch-client';
import { readItemPageByFetch } from '../core/item/clients/item-fetch-client';

// tests run from `dist/tests`, the fixtures stay in `src/tests/fixtures`
const fixture = (name: string): string =>
	fs.readFileSync(path.join(__dirname, '../../src/tests/fixtures', name), 'utf8');

type Handler = (req: http.IncomingMessage, body: string) => { status: number, headers?: Record<string, string>, body?: string };

let server: http.Server;
let origin: string;
let handler: Handler;
let requests: string[];

const accountBlob = (blob: object): string =>
	`<html><body><div id="pagedata" data-blob="${JSON.stringify(blob).replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"></div></body></html>`;

const tab = (count: number, token: string | null) => ({ item_count: count, last_token: token });

// A fan page: the collection has 1 embedded item and 2 more on the API, the other tabs are empty.
const fanBlob = {
	fan_data: { fan_id: 7 },
	collection_data: tab(3, 't1'),
	wishlist_data: tab(0, null),
	followers_data: tab(0, null),
	following_fans_data: tab(0, null),
	item_cache: { collection: { 'a1': { item_url: 'https://x.bandcamp.com/album/one?from=a' } } },
};

before(async () => {
	server = http.createServer((req, res) => {
		let body = '';
		req.on('data', chunk => body += chunk);
		req.on('end', () => {
			requests.push(`${req.method} ${req.url}`);
			const answer = handler(req, body);
			res.writeHead(answer.status, { 'content-type': 'text/html', ...answer.headers });
			res.end(answer.body ?? '');
		});
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => server.close());

beforeEach(() => {
	requests = [];
});

/** Real HTTP to the local server: every host of Bandcamp is rewritten to it. */
function createClient(gate = new RateLimitGate({ sleep: async () => { } })): HttpClient {
	const toLocal: typeof fetch = (input, init) =>
		fetch(String(input).replace(/^https?:\/\/[^/]+/, origin), init);
	return new HttpClient(gate, { fetchFn: toLocal, minDelayMs: 0, maxDelayMs: 0, timeoutMs: 2_000 });
}

describe('item reader', () => {
	const itemUrl = 'https://band.bandcamp.com/album/we-rise';

	it('reads an album page and all supporters from the API', async () => {
		const tokens: string[] = [];
		handler = (req, body) => {
			if (req.method === 'GET') {
				return { status: 200, body: fixture('item-album.html') };
			}
			const { token, tralbum_type, tralbum_id, count } = JSON.parse(body);
			assert.equal(tralbum_type, 'a');
			assert.equal(tralbum_id, 3478961259);
			assert.equal(count, 100);
			tokens.push(token);
			return tokens.length === 1
				? { status: 200, body: JSON.stringify({ results: [{ username: 'p1', token: 'p1' }, { username: 'p2', token: 'p2' }], more_available: true }) }
				: { status: 200, body: JSON.stringify({ results: [{ username: 'p3', token: 'p3' }], more_available: false }) };
		};

		const data = await readItemPageByFetch(itemUrl, createClient());

		assert.deepEqual(data.errors, []);
		assert.equal(data.accounts.data.length, 3 + 3);
		assert.ok(data.accounts.data.every(x => x.startsWith('https://bandcamp.com/') && !x.includes('?')));
		assert.deepEqual(data.accounts.data.slice(3), ['https://bandcamp.com/p1', 'https://bandcamp.com/p2', 'https://bandcamp.com/p3']);
		assert.deepEqual(data.tags.data, ['acid', 'breakbeat', 'electronic', 'tech']);
		assert.equal(data.releaseDate.data.getFullYear(), 2024);
		assert.deepEqual(data.tracks.data, ['https://band.bandcamp.com/track/we-rise']);
		assert.equal(data.album.data, null);
		assert.equal(data.imageUrl.data, 'https://f4.bcbits.com/img/a2827326170_2.jpg');
		assert.equal(tokens.length, 2);
		assert.equal(tokens[1], 'p2', 'the next call continues from the last token received');
	});

	it('reads a track page with the album link and no API call when nothing is left', async () => {
		handler = () => ({ status: 200, body: fixture('item-track.html') });

		const data = await readItemPageByFetch('https://band.bandcamp.com/track/we-rise', createClient());

		assert.deepEqual(data.errors, []);
		assert.equal(data.album.data, 'https://band.bandcamp.com/album/we-rise');
		assert.equal(data.tracks.data, null);
		assert.equal(data.accounts.data.length, 3);
		assert.deepEqual(requests, ['GET /track/we-rise']);
	});

	it('maps 404 and the "not found" page to "Page did not exist"', async () => {
		handler = () => ({ status: 404, body: fixture('item-dead.html') });
		await assert.rejects(readItemPageByFetch(itemUrl, createClient()), { message: 'Page did not exist' });
		await assert.rejects(readItemPageByFetch(itemUrl, createClient()), PageNotFoundError);

		handler = () => ({ status: 200, body: fixture('item-dead.html') });
		await assert.rejects(readItemPageByFetch(itemUrl, createClient()), { message: 'Page did not exist' });
	});

	it('maps 429 with Retry-After to RateLimitedError and starts the pause', async () => {
		handler = () => ({ status: 429, headers: { 'retry-after': '42' } });
		const gate = new RateLimitGate({ sleep: async () => { } });

		await assert.rejects(readItemPageByFetch(itemUrl, createClient(gate)), (e: RateLimitedError) => {
			assert.ok(e instanceof RateLimitedError);
			assert.equal(e.retryAfter, '42');
			return true;
		});
		assert.ok(gate.isPaused);
	});

	it('maps 429 without Retry-After to RateLimitedError', async () => {
		handler = () => ({ status: 429 });
		const gate = new RateLimitGate({ sleep: async () => { } });

		await assert.rejects(readItemPageByFetch(itemUrl, createClient(gate)), (e: RateLimitedError) => {
			assert.ok(e instanceof RateLimitedError);
			assert.equal(e.retryAfter, undefined);
			return true;
		});
		assert.ok(gate.isPaused);
	});

	it('fails the page when the supporters API is refused', async () => {
		handler = req => req.method === 'GET'
			? { status: 200, body: fixture('item-album.html') }
			: { status: 403 };

		await assert.rejects(readItemPageByFetch(itemUrl, createClient()), /Supporters API refused with status 403/);
		await assert.rejects(readItemPageByFetch(itemUrl, createClient()), ApiRefusedError);
	});

	it('maps 429 of the supporters API to RateLimitedError', async () => {
		handler = req => req.method === 'GET'
			? { status: 200, body: fixture('item-album.html') }
			: { status: 429, headers: { 'retry-after': '5' } };

		await assert.rejects(readItemPageByFetch(itemUrl, createClient()), RateLimitedError);
	});

	it('fails normally on other statuses and on network errors', async () => {
		handler = () => ({ status: 500 });
		await assert.rejects(readItemPageByFetch(itemUrl, createClient()), (e: Error) => {
			assert.ok(!(e instanceof RateLimitedError));
			assert.ok(e instanceof HttpStatusError);
			assert.match(e.message, /HTTP 500/);
			return true;
		});

		// a port nobody listens on: take a free one and close it again
		const probe = http.createServer();
		await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
		const closedPort = (probe.address() as { port: number }).port;
		await new Promise(resolve => probe.close(resolve));

		const closed = new HttpClient(new RateLimitGate(), {
			fetchFn: () => fetch(`http://127.0.0.1:${closedPort}/`),
			minDelayMs: 0,
			maxDelayMs: 0,
		});
		await assert.rejects(readItemPageByFetch(itemUrl, closed), (e: Error) => {
			assert.ok(!(e instanceof RateLimitedError));
			assert.equal(e.message, `Request failed (ECONNREFUSED): ${itemUrl}`);
			assert.ok(e.cause instanceof TypeError, 'the fetch error is kept as the cause');
			return true;
		});
	});
});

describe('account reader', () => {
	const accountUrl = 'https://bandcamp.com/fan';

	it('reads the embedded batch and pages the API with count 20', async () => {
		const calls: any[] = [];
		handler = (req, body) => {
			if (req.method === 'GET') {
				return { status: 200, body: accountBlob(fanBlob) };
			}
			calls.push({ url: req.url, ...JSON.parse(body) });
			return calls.length === 1
				? { status: 200, body: JSON.stringify({ items: [{ item_url: 'https://x.bandcamp.com/album/two' }, { item_url: 'https://x.bandcamp.com/track/three?x=1' }], more_available: true, last_token: 't2' }) }
				: { status: 200, body: JSON.stringify({ items: [{ item_url: 'https://x.bandcamp.com/album/two' }], more_available: false, last_token: 't2' }) };
		};

		const data = await readAccountPageByFetch(accountUrl, createClient());

		assert.deepEqual(data.errors, []);
		assert.equal(data.collection.total, 3);
		assert.deepEqual(data.collection.urls, [
			'https://x.bandcamp.com/album/one',
			'https://x.bandcamp.com/album/two',
			'https://x.bandcamp.com/track/three',
		]);
		assert.deepEqual(data.followers, { total: 0, urls: [] });
		assert.equal(calls[0].url, '/api/fancollection/1/collection_items');
		assert.equal(calls[0].count, 20);
		assert.equal(calls[0].fan_id, 7);
		assert.equal(calls[0].older_than_token, 't1');
		assert.equal(calls[1].older_than_token, 't2');
	});

	it('maps 404 and a page without #pagedata to "Page did not exist"', async () => {
		handler = () => ({ status: 404 });
		await assert.rejects(readAccountPageByFetch(accountUrl, createClient()), { message: 'Page did not exist' });

		handler = () => ({ status: 200, body: '<html><body>nothing</body></html>' });
		await assert.rejects(readAccountPageByFetch(accountUrl, createClient()), { message: 'Page did not exist' });
		await assert.rejects(readAccountPageByFetch(accountUrl, createClient()), PageNotFoundError);
	});

	it('maps 429 of the page and of the API to RateLimitedError', async () => {
		handler = () => ({ status: 429, headers: { 'retry-after': '10' } });
		await assert.rejects(readAccountPageByFetch(accountUrl, createClient()), RateLimitedError);

		handler = req => req.method === 'GET'
			? { status: 200, body: accountBlob(fanBlob) }
			: { status: 429 };
		await assert.rejects(readAccountPageByFetch(accountUrl, createClient()), RateLimitedError);
	});

	it('fails the whole account when the API refuses a request', async () => {
		handler = req => req.method === 'GET'
			? { status: 200, body: accountBlob(fanBlob) }
			: { status: 403 };

		await assert.rejects(readAccountPageByFetch(accountUrl, createClient()), /refused "collection_items" with status 403/);
		await assert.rejects(readAccountPageByFetch(accountUrl, createClient()), ApiRefusedError);
	});
});

describe('http client', () => {
	it('waits while the gate is paused and keeps the minimum delay between requests', async () => {
		handler = () => ({ status: 200 });
		const sleeps: number[] = [];
		let time = 1_000;
		// no jitter: a random pause made the clock fractional and the sum below inexact
		const gate = new RateLimitGate({ now: () => time, random: () => 0, sleep: async ms => { sleeps.push(ms); time += ms; } });
		gate.trip('2');

		const client = new HttpClient(gate, {
			fetchFn: (input, init) => fetch(String(input).replace(/^https?:\/\/[^/]+/, origin), init),
			minDelayMs: 500,
			maxDelayMs: 1_500,
			random: () => 0.5,
			now: () => time,
			sleep: async ms => { sleeps.push(ms); time += ms; },
		});

		await client.get('https://x.bandcamp.com/a');
		assert.ok(sleeps[0] >= 2_000, 'waited out the 429 pause');

		sleeps.length = 0;
		await client.get('https://x.bandcamp.com/b');
		assert.deepEqual(sleeps, [1_000], 'waited min + jitter (500 + 0.5 * 1000)');
	});

	it('cancels a request that takes longer than the timeout', async () => {
		const waitForAbort: typeof fetch = (_input, init) => new Promise<Response>((_resolve, reject) => {
			init.signal.addEventListener('abort', () => reject(init.signal.reason));
		});
		const client = new HttpClient(new RateLimitGate(), { fetchFn: waitForAbort, minDelayMs: 0, maxDelayMs: 0, timeoutMs: 50 });

		await assert.rejects(client.get('https://x.bandcamp.com/slow'), { name: 'TimeoutError' });
	});

	it('sends browser headers on GET and JSON headers on POST', async () => {
		const seen: { method: string, headers: http.IncomingHttpHeaders, body: string }[] = [];
		handler = (req, body) => {
			seen.push({ method: req.method, headers: req.headers, body });
			return { status: 200, body: 'ok' };
		};
		const client = createClient();

		assert.deepEqual(await client.get('https://x.bandcamp.com/a'), { status: 200, body: 'ok' });
		await client.postJson('https://x.bandcamp.com/api', { a: 1 });

		const userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
		const [get, post] = seen;
		assert.equal(get.method, 'GET');
		assert.equal(get.headers['user-agent'], userAgent);
		assert.equal(get.headers['accept-language'], 'en-US,en;q=0.9');
		assert.equal(get.headers['accept'], 'text/html,application/xhtml+xml');
		assert.equal(get.headers['cookie'], undefined);
		assert.equal(post.method, 'POST');
		assert.equal(post.headers['user-agent'], userAgent);
		assert.equal(post.headers['accept'], 'application/json');
		assert.equal(post.headers['content-type'], 'application/json');
		assert.equal(post.body, '{"a":1}');
	});

	it('returns other statuses as they are', async () => {
		handler = () => ({ status: 503, body: 'down' });

		assert.deepEqual(await createClient().get('https://x.bandcamp.com/a'), { status: 503, body: 'down' });
	});
});
