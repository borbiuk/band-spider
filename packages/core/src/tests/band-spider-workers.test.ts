import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BandSpider, BandSpiderTuning } from '../band-spider';
import { FailureReport, HttpStatusError, NetworkError, PageNotFoundError } from '../common/errors';
import { HttpClient } from '../common/http-client';
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

	/** The URL for control requests. */
	public control: string | undefined = 'https://bandcamp.com/control';

	public async controlUrl(): Promise<string | undefined> { return this.control; }
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

const reader = (
	onItem: (url: string) => Promise<ItemPageData> | ItemPageData = itemData,
	/** The answer to a control request. */
	onControl: () => boolean = () => true,
): PageReader => ({
	readItemPage: async url => onItem(url),
	readAccountPage: async () => { throw new Error('not used'); },
	isAccountPageReadable: async () => onControl(),
});

/** Short times: a held answer waits 20 ms for a confirmation, the pause after a failed control request is 30 ms. */
const fast: BandSpiderTuning = { suspects: { confirmWindowMs: 20 }, controlPauseMs: 30 };

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
	/** A store whose released URLs are not queued again: a loop with no real I/O would starve the timers of the test. */
	const storeOf = (...urls: string[]): FakeStore => {
		const store = new FakeStore();
		store.release = async (task, reason) => { store.released.push(`${reason}:${task.url}`); };
		store.queue.push(...urls);
		return store;
	};

	it('saves a network error as a failure with its status when the control request passes', async () => {
		const url = 'https://a.bandcamp.com/track/1';
		const store = storeOf(url);
		const failures: FailureReport[] = [];
		const stop = new AbortController();
		const spider = new BandSpider(store, () => reader(() => { throw new HttpStatusError(503, url); }), failure => failures.push(failure), fast);
		const running = spider.run(options({ idleWaitMs: 10 }), stop.signal);

		await until(() => failures.length > 0);
		stop.abort();
		await running;

		assert.deepEqual(failures[0], { key: 'http:503', message: `HTTP 503: ${url}`, url });
		assert.deepEqual(store.released, [`failed:${url}`]);
	});

	it('saves a 404 between two read pages as not found without a control request', async () => {
		const gone = 'https://a.bandcamp.com/track/gone';
		const store = storeOf('https://a.bandcamp.com/track/1', gone, 'https://a.bandcamp.com/track/2');
		let controls = 0;
		const stop = new AbortController();
		const spider = new BandSpider(store, () => reader(
			url => { if (url === gone) { throw new PageNotFoundError(); } return itemData(url); },
			() => { controls++; return true; },
		));
		const running = spider.run(options({ idleWaitMs: 10 }), stop.signal);

		await until(() => store.released.length > 0);
		stop.abort();
		await running;

		assert.deepEqual(store.released, [`notFound:${gone}`]);
		assert.equal(controls, 0);
	});

	for (const type of [UrlType.Item, UrlType.Account]) {
		it(`saves an ${type} 404 as not found when the control request passes`, async () => {
			const url = type === UrlType.Item ? 'https://a.bandcamp.com/track/gone' : 'https://bandcamp.com/gone';
			const store = storeOf(url);
			const failures: FailureReport[] = [];
			const stop = new AbortController();
			const notFound = async (): Promise<never> => { throw new PageNotFoundError(); };
			const spider = new BandSpider(
				store,
				() => ({ readItemPage: notFound, readAccountPage: notFound, isAccountPageReadable: async () => true }),
				failure => failures.push(failure),
				fast,
			);
			const running = spider.run(options({ idleWaitMs: 10, type }), stop.signal);

			await until(() => store.released.length > 0);
			stop.abort();
			await running;

			assert.deepEqual(store.released, [`notFound:${url}`]);
			assert.deepEqual(failures.map(x => x.key), ['not-found']);
			assert.equal(spider.warning, undefined);
		});
	}

	it('drops a 404 when the control request fails, pauses, and stops when it fails again', async () => {
		const url = 'https://a.bandcamp.com/track/gone';
		const store = storeOf(url);
		let controls = 0;
		const spider = new BandSpider(store, () => reader(() => { throw new PageNotFoundError(); }, () => { controls++; return false; }), undefined, fast);

		await assert.rejects(spider.run(options({ idleWaitMs: 10 })), /404 warning: the control request failed twice/);
		// tried again later, with no mark
		assert.deepEqual(store.released, [`rateLimited:${url}`]);
		assert.equal(controls, 2);
		assert.equal(spider.warning?.kind, 'notFound');
	});

	it('names a network warning when network errors made the control request', async () => {
		const store = storeOf('https://a.bandcamp.com/track/1');
		const spider = new BandSpider(store, () => reader(url => { throw new NetworkError(`Request failed (0): ${url}`, '0'); }, () => false), undefined, fast);

		await assert.rejects(spider.run(options({ idleWaitMs: 10 })), /network warning/);
		assert.equal(spider.warning?.kind, 'connection');
	});

	it('clears the warning when the control request after the pause passes', async () => {
		const store = storeOf('https://a.bandcamp.com/track/gone');
		let controls = 0;
		let warned = false;
		const stop = new AbortController();
		const spider: BandSpider = new BandSpider(store, () => reader(
			() => { throw new PageNotFoundError(); },
			() => {
				controls++;
				warned ||= spider.warning !== undefined;
				return controls > 1;
			},
		), undefined, fast);
		const running = spider.run(options({ idleWaitMs: 10 }), stop.signal);

		await until(() => controls === 2);
		await until(() => spider.warning === undefined);
		stop.abort();
		await running;

		assert.equal(warned, true);
	});

	it('gives held URLs back without a mark when the crawler stops', async () => {
		const url = 'https://a.bandcamp.com/track/gone';
		const store = storeOf(url);
		const stop = new AbortController();
		// the default window is long: the 404 is still held when the crawler stops
		const spider = new BandSpider(store, () => reader(() => { throw new PageNotFoundError(); }));
		const running = spider.run(options({ idleWaitMs: 10 }), stop.signal);

		await until(() => store.claims > 1);
		stop.abort();
		await running;

		assert.deepEqual(store.released, [`rateLimited:${url}`]);
	});

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
