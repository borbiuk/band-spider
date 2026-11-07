import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BandSpider, MAX_PAUSES_IN_ROW } from '../band-spider';
import { FailureReport, HttpStatusError, NetworkError, PageNotFoundError } from '../common/errors';
import { HttpClient } from '../common/http-client';
import { BurstGuard } from '../common/burst-guard';
import { RateLimitedError } from '../common/rate-limit-gate';
import type { CrawlStore, CrawlTask } from '../crawl-store';
import { defaultItemTabStatistic } from '../item/models/item-tab-statistic';
import type { ItemPageData } from '../item/models/item-page-data';
import { UrlType } from '../models/url-type';
import type { PageReader } from '../page-reader';

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Waits until the condition is true, or fails after a time. */
const until = async (condition: () => boolean, timeoutMs = 5_000): Promise<void> => {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		assert.ok(Date.now() < deadline, 'timed out');
		await pause(5);
	}
};

/** A store with a list of URLs that a test can fill at any time. */
class FakeStore implements CrawlStore {
	public readonly queue: string[] = [];
	public readonly saved: string[] = [];
	public readonly released: string[] = [];
	public claims = 0;
	private nextId = 1;

	public async resetBusy(): Promise<void> { }

	public async claim(type: UrlType): Promise<CrawlTask[]> {
		this.claims++;
		const url = this.queue.shift();
		return url === undefined ? [] : [{ id: this.nextId++, url, type }];
	}

	public async extendLease(): Promise<boolean> { return true; }

	public async saveItem(task: CrawlTask): Promise<never> {
		this.saved.push(task.url);
		const stat = defaultItemTabStatistic;
		return { accounts: stat, tags: stat, releaseDate: stat, album: stat, tracks: stat, newUrls: [] } as never;
	}

	public async saveAccount(): Promise<never> { throw new Error('not used'); }

	public async release(task: CrawlTask, reason: string): Promise<void> {
		this.released.push(`${reason}:${task.url}`);
		this.queue.push(task.url);
	}
}

const itemData = (url: string): ItemPageData => ({
	url,
	accounts: { data: [] },
	tags: { data: [] },
	releaseDate: { data: new Date('2024-03-01T00:00:00.000Z') },
	album: { data: null },
	tracks: { data: [] },
	imageUrl: { data: null },
	errors: [],
});

const reader = (onItem: (url: string) => Promise<ItemPageData> | ItemPageData = itemData): PageReader => ({
	readItemPage: async url => onItem(url),
	readAccountPage: async () => { throw new Error('not used'); },
});

/** A guard that trusts every answer, so a single 404 or network error counts at once. */
const trustingGuard = () => new BurstGuard({ minSamples: 1, maxShare: 1 });

const options = (extra: { concurrency?: number, idleWaitMs?: number, type?: UrlType } = {}) => ({
	concurrency: 1, type: UrlType.Item, superTag: false, reverse: false, minDelayMs: 0, maxDelayMs: 0, ...extra,
});

describe('BandSpider without idleWaitMs (CLI)', () => {
	it('ends when the queue is empty', async () => {
		const store = new FakeStore();
		store.queue.push('https://a.bandcamp.com/track/1');

		await new BandSpider(store, () => reader()).run(options());

		assert.deepEqual(store.saved, ['https://a.bandcamp.com/track/1']);
	});
});

describe('BandSpider with idleWaitMs (crawler)', () => {
	it('waits on an empty queue and picks up URLs that appear later', async () => {
		const store = new FakeStore();
		const spider = new BandSpider(store, () => reader());
		const stop = new AbortController();
		const running = spider.run(options({ idleWaitMs: 10 }), stop.signal);

		await until(() => spider.isIdle);
		assert.equal(store.saved.length, 0);

		store.queue.push('https://a.bandcamp.com/track/late');
		await until(() => store.saved.length === 1);
		// it waits again after the URL
		await until(() => spider.isIdle);

		stop.abort();
		await running;
		assert.deepEqual(store.saved, ['https://a.bandcamp.com/track/late']);
	});

	it('ends the idle wait at once when the stop signal is aborted', async () => {
		const store = new FakeStore();
		const spider = new BandSpider(store, () => reader());
		const stop = new AbortController();
		// the wait is much longer than the test allows
		const running = spider.run(options({ idleWaitMs: 60_000 }), stop.signal);
		await until(() => spider.isIdle);

		const before = Date.now();
		stop.abort();
		await running;

		assert.ok(Date.now() - before < 1_000);
	});
});

describe('workers of one BandSpider run', () => {
	it('share one HTTP client', async () => {
		const store = new FakeStore();
		const clients = new Set<HttpClient>();
		await new BandSpider(store, http => { clients.add(http); return reader(); }).run(options({ concurrency: 3 }));

		assert.equal(clients.size, 1);
	});

	it('are all paused by the 429 of one of them', async () => {
		const store = new FakeStore();
		for (let i = 0; i < 4; i++) {
			store.queue.push(`https://a.bandcamp.com/track/${i}`);
		}
		const clients = new Set<HttpClient>();
		let limited = false;
		const spider = new BandSpider(store, http => {
			clients.add(http);
			return reader(url => {
				// the first read of any worker is rate limited
				if (!limited) {
					limited = true;
					throw new RateLimitedError(url, '1');
				}
				return itemData(url);
			});
		});
		const stop = new AbortController();
		const running = spider.run(options({ concurrency: 3, idleWaitMs: 10 }), stop.signal);

		await until(() => store.released.length > 0);
		const [client] = [...clients];
		await until(() => client.pauseLeftMs > 0);
		// one client, so one gate: the pause is the pause of every worker
		assert.equal(clients.size, 1);
		const savedDuringPause = store.saved.length;
		await pause(100);
		assert.equal(store.saved.length, savedDuringPause, 'no worker took a URL during the pause');

		stop.abort();
		await running;
	});
});

describe('failure reports', () => {
	it('names the HTTP status of a page that could not be read', async () => {
		const store = new FakeStore();
		// a failed URL is not queued again: a loop with no real I/O would starve the timers of the test
		store.release = async (task, reason) => { store.released.push(`${reason}:${task.url}`); };
		const url = 'https://a.bandcamp.com/track/1';
		store.queue.push(url);
		const failures: FailureReport[] = [];
		const stop = new AbortController();
		const spider = new BandSpider(store, () => reader(() => { throw new HttpStatusError(503, url); }), failure => failures.push(failure), trustingGuard);
		const running = spider.run(options({ idleWaitMs: 10 }), stop.signal);

		await until(() => failures.length > 0);
		stop.abort();
		await running;

		assert.deepEqual(failures[0], { key: 'http:503', message: `HTTP 503: ${url}`, url });
		assert.equal(store.released[0], `failed:${url}`);
	});

	it('only releases a URL with a network error the guard does not trust', async () => {
		const store = new FakeStore();
		store.release = async (task, reason) => { store.released.push(`${reason}:${task.url}`); };
		const url = 'https://a.bandcamp.com/track/1';
		store.queue.push(url);
		const failures: FailureReport[] = [];
		const stop = new AbortController();
		// the default guard needs more answers before it trusts a network error
		const spider = new BandSpider(store, () => reader(() => { throw new NetworkError(`Request failed (0): ${url}`, '0'); }), failure => failures.push(failure));
		const running = spider.run(options({ idleWaitMs: 10 }), stop.signal);

		await until(() => failures.length > 0);
		stop.abort();
		await running;

		assert.deepEqual(failures.map(x => x.key), ['network:0']);
		assert.deepEqual(store.released, [`rateLimited:${url}`]);
	});

	it('stops with an error after too many pauses in a row', async () => {
		const store = new FakeStore();
		store.queue.push('https://a.bandcamp.com/track/1');
		let reads = 0;
		// a pause of 0 seconds: each 429 starts a new pause right away
		const spider = new BandSpider(store, () => reader(url => { reads++; throw new RateLimitedError(url, '0'); }));

		await assert.rejects(spider.run(options({ idleWaitMs: 10 })), /Requests kept failing: 8 pauses in a row/);
		assert.equal(reads, MAX_PAUSES_IN_ROW);
	});

	/** Runs the spider on one URL that answers 404 and returns the release and the failure keys. */
	const runNotFound = async (type: UrlType, guard?: () => BurstGuard) => {
		const store = new FakeStore();
		// a released URL is not queued again: a loop with no real I/O would starve the timers of the test
		store.release = async (task, reason) => { store.released.push(`${reason}:${task.url}`); };
		const url = type === UrlType.Item ? 'https://a.bandcamp.com/track/gone' : 'https://bandcamp.com/gone';
		store.queue.push(url);
		const failures: FailureReport[] = [];
		const stop = new AbortController();
		const notFound = async (): Promise<never> => { throw new PageNotFoundError(); };
		const spider = new BandSpider(
			store,
			() => ({ readItemPage: notFound, readAccountPage: notFound }),
			failure => failures.push(failure),
			guard,
		);
		const running = spider.run(options({ idleWaitMs: 10, type }), stop.signal);

		await until(() => store.released.length > 0);
		stop.abort();
		await running;
		return { url, released: store.released, keys: failures.map(x => x.key) };
	};

	for (const type of [UrlType.Item, UrlType.Account]) {
		it(`releases an ${type} page that does not exist as not found when the guard trusts the 404`, async () => {
			const { url, released, keys } = await runNotFound(type, trustingGuard);

			assert.deepEqual(released, [`notFound:${url}`]);
			assert.deepEqual(keys, ['not-found']);
		});

		it(`only releases an ${type} page with a 404 the guard does not trust`, async () => {
			// the default guard needs more answers before it trusts a 404
			const { url, released, keys } = await runNotFound(type);

			assert.deepEqual(released, [`rateLimited:${url}`]);
			assert.deepEqual(keys, ['not-found:unsure']);
		});
	}

	it('reports each scraping issue of a saved page', async () => {
		const store = new FakeStore();
		// a failed URL is not queued again: a loop with no real I/O would starve the timers of the test
		store.release = async (task, reason) => { store.released.push(`${reason}:${task.url}`); };
		store.queue.push('https://a.bandcamp.com/track/2');
		const failures: FailureReport[] = [];
		const stop = new AbortController();
		const spider = new BandSpider(
			store,
			() => reader(url => ({ ...itemData(url), errors: [new Error('missing title')] })),
			failure => failures.push(failure),
		);
		const running = spider.run(options({ idleWaitMs: 10 }), stop.signal);

		await until(() => failures.length > 0);
		stop.abort();
		await running;

		assert.equal(failures[0].key, 'scrape');
		assert.equal(failures[0].message, 'missing title');
	});
});
