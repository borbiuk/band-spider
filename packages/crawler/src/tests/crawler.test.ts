import 'reflect-metadata';

import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
	AccountPageData,
	CrawlTask,
	HttpClient,
	ItemPageData,
	PageReader,
	UrlType,
} from '@band-spider/core';
import { RunningDbService, startDbService } from '@band-spider/db-service';
import { BandDatabase } from '@band-spider/storage-sqlite';
import {
	CrawlerConfig,
	CrawlerEvent,
	DEFAULT_IDLE_MS,
	toSpiderOptions,
	CrawlTransport,
	DbServiceError,
	HttpCrawlTransport,
	parseCrawlerConfig,
	readEnvConfig,
	RemoteCrawlStore,
	runCrawler,
} from '../index';

const tempDir: string = fs.mkdtempSync(path.join(os.tmpdir(), 'band-spider-crawler-'));
let counter = 0;

/** A real DB service on a temporary file, and a second connection to look into the file. */
const openService = async (token?: string): Promise<{ service: RunningDbService, seed: BandDatabase, close: () => Promise<void> }> => {
	const file = path.join(tempDir, `crawler-${counter++}.sqlite`);
	const service = await startDbService({ host: '127.0.0.1', port: 0, token, database: { file, synchronize: true } });
	const seed = await BandDatabase.open({ file, synchronize: false });
	return {
		service,
		seed,
		close: async () => {
			await seed.close();
			await service.stop();
		},
	};
};

const config = (service: RunningDbService, extra: Partial<CrawlerConfig> = {}): CrawlerConfig => ({
	dbUrl: service.url,
	type: 'item',
	reverse: false,
	workers: 1,
	minDelayMs: 0,
	maxDelayMs: 0,
	idleMs: 0,
	...extra,
});

const itemData = (url: string, extra: Partial<ItemPageData> = {}): ItemPageData => ({
	url,
	accounts: { data: ['https://bandcamp.com/crawler-fan'] },
	tags: { data: ['crawler-tag'] },
	releaseDate: { data: new Date('2024-03-01T00:00:00.000Z') },
	album: { data: null },
	tracks: { data: [] },
	imageUrl: { data: null },
	errors: [],
	...extra,
});

const emptyTab = { total: 0, urls: [] as string[], complete: true };

/** A reader that answers from a function and does not need the network. */
class FakeReader implements PageReader {
	public readonly itemUrls: string[] = [];
	public readonly accountMarks: Array<CrawlTask['marks']> = [];

	constructor(
		private readonly onItem: (url: string) => Promise<ItemPageData> | ItemPageData = url => itemData(url),
		private readonly onAccount: (url: string) => Promise<AccountPageData> | AccountPageData = url => ({
			url, collection: emptyTab, wishlist: emptyTab, followers: emptyTab, following: emptyTab, errors: [],
		}),
	) {
	}

	public async readItemPage(url: string): Promise<ItemPageData> {
		this.itemUrls.push(url);
		return this.onItem(url);
	}

	public async readAccountPage(url: string): Promise<AccountPageData> {
		return this.onAccount(url);
	}
}

const row = async (db: BandDatabase, table: 'items' | 'accounts', url: string) =>
	(await db.query(`SELECT lastProcessingDate IS NOT NULL AS processed, isBusy, failedCount FROM ${table} WHERE url = ?`, [url]))[0];

after(() => {
	fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('crawler against a real DB service', () => {
	it('claims, reads with a fake reader and saves every item', async () => {
		const { service, seed, close } = await openService();
		try {
			const urls = [1, 2, 3].map(n => `https://crawl.bandcamp.com/track/${n}`);
			for (const url of urls) {
				await seed.item.insert(url);
			}

			const events: CrawlerEvent[] = [];
			const reader = new FakeReader();
			const counts = await runCrawler(config(service, { workers: 2 }), {
				createReader: () => reader,
				onEvent: event => events.push(event),
				progressIntervalMs: 0,
			});

			assert.deepEqual(counts, { claimed: 3, saved: 3, failed: 0, rateLimited: 0, notFound: 0 });
			assert.deepEqual([...reader.itemUrls].sort(), urls);
			for (const url of urls) {
				assert.deepEqual(await row(seed, 'items', url), { processed: 1, isBusy: 0, failedCount: 0 });
			}

			assert.equal(events[0].type, 'started');
			assert.ok(events.some(event => event.type === 'progress'));
			assert.deepEqual(events.at(-1), { type: 'stopped', counts });

			// the account of the pages was saved by the service
			const accounts = await seed.query('SELECT url FROM accounts WHERE url = ?', ['https://bandcamp.com/crawler-fan']);
			assert.equal(accounts.length, 1);
		} finally {
			await close();
		}
	});

	it('releases a failed URL and keeps going', async () => {
		const { service, seed, close } = await openService();
		try {
			const bad = 'https://crawl.bandcamp.com/track/bad';
			const good = 'https://crawl.bandcamp.com/track/good';
			await seed.item.insert(bad);
			await seed.item.insert(good);

			const reader = new FakeReader(url => {
				if (url === bad) {
					throw new Error('boom');
				}
				return itemData(url);
			});
			const counts = await runCrawler(config(service), { createReader: () => reader });

			assert.equal(counts.saved, 1);
			assert.equal(counts.failed, 1);
			assert.deepEqual(await row(seed, 'items', bad), { processed: 0, isBusy: 0, failedCount: 1 });
			assert.deepEqual(await row(seed, 'items', good), { processed: 1, isBusy: 0, failedCount: 0 });
		} finally {
			await close();
		}
	});

	it('finishes the current URL on stop and leaves nothing busy', async () => {
		const { service, seed, close } = await openService();
		try {
			const urls = [1, 2, 3].map(n => `https://crawl.bandcamp.com/track/stop-${n}`);
			for (const url of urls) {
				await seed.item.insert(url);
			}

			const stop = new AbortController();
			// the stop comes while the first URL is read
			const reader = new FakeReader(url => {
				stop.abort();
				return itemData(url);
			});
			const counts = await runCrawler(config(service), { createReader: () => reader, signal: stop.signal });

			assert.equal(counts.saved, 1);
			assert.equal(reader.itemUrls.length, 1);
			const busy = await seed.query('SELECT COUNT(*) AS n FROM items WHERE isBusy = 1');
			assert.equal(busy[0].n, 0);
			const left = await seed.query('SELECT COUNT(*) AS n FROM items WHERE lastProcessingDate IS NULL');
			assert.equal(left[0].n, 2);
		} finally {
			await close();
		}
	});

	it('keeps waiting on an empty queue, picks up new URLs and stops on the signal', async () => {
		const { service, seed, close } = await openService();
		try {
			const stop = new AbortController();
			const reader = new FakeReader(url => itemData(url));
			const events: CrawlerEvent[] = [];
			const running = runCrawler(config(service, { idleMs: 20 }), {
				createReader: () => reader,
				signal: stop.signal,
				onEvent: event => events.push(event),
				metricsIntervalMs: 10,
			});

			// the queue is empty: the crawler must still run and report that it waits
			await new Promise(resolve => setTimeout(resolve, 150));
			assert.ok(events.some(event => event.type === 'metrics' && event.metrics.idle));
			assert.equal(events.some(event => event.type === 'stopped'), false);

			await seed.item.insert('https://crawl.bandcamp.com/track/late-1');
			const deadline = Date.now() + 5_000;
			while (reader.itemUrls.length < 1 && Date.now() < deadline) {
				await new Promise(resolve => setTimeout(resolve, 10));
			}
			assert.deepEqual(reader.itemUrls, ['https://crawl.bandcamp.com/track/late-1']);

			stop.abort();
			const counts = await running;
			assert.equal(counts.saved, 1);
		} finally {
			await close();
		}
	});

	it('saves an account and sends tab errors as messages', async () => {
		const { service, seed, close } = await openService();
		try {
			const url = 'https://bandcamp.com/crawl-owner';
			const album = 'https://crawl-owner.bandcamp.com/album/one';
			await seed.account.insert(url);
			await seed.query('UPDATE accounts SET lastProcessingDate = CURRENT_DATE WHERE url != ? AND lastProcessingDate IS NULL', [url]);

			const reader = new FakeReader(undefined, accountUrl => ({
				url: accountUrl,
				collection: { total: 1, urls: [album], complete: true },
				wishlist: { total: 0, urls: [], complete: false, error: new Error('wishlist failed') },
				followers: emptyTab,
				following: emptyTab,
				errors: [new Error('one error')],
			}));
			const counts = await runCrawler(config(service, { type: 'account' }), { createReader: () => reader });

			// a page with an error is saved and then released as failed by the handler
			assert.equal(counts.saved, 1);
			assert.equal(counts.failed, 1);
			assert.equal((await seed.query('SELECT url FROM items WHERE url = ?', [album])).length, 1);
		} finally {
			await close();
		}
	});

	it('sends the bearer token and fails clearly without it', async () => {
		const { service, close } = await openService('secret');
		try {
			const store = new RemoteCrawlStore(new HttpCrawlTransport(service.url, { token: 'secret' }));
			assert.deepEqual(await store.claim(UrlType.Item, 1, false), []);
			store.close();

			const refused = new RemoteCrawlStore(new HttpCrawlTransport(service.url));
			await assert.rejects(refused.claim(UrlType.Item, 1, false), (error: Error) =>
				error instanceof DbServiceError && error.status === 401);
			refused.close();
		} finally {
			await close();
		}
	});

	it('refuses resetBusy: only the service owner clears busy flags', async () => {
		const store = new RemoteCrawlStore({ post: async () => ({}) });
		await assert.rejects(store.resetBusy(), /owner of the store/);
	});
});

describe('crawler with a fake proxy', () => {
	const connects: string[] = [];
	let target: http.Server;
	let proxy: http.Server;
	let targetPort: number;
	let proxyUrl: string;

	before(async () => {
		target = http.createServer((_request, response) => response.end('from-target'));
		await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve));
		targetPort = (target.address() as net.AddressInfo).port;

		// a minimal HTTP proxy: a CONNECT tunnel to the asked host
		proxy = http.createServer();
		proxy.on('connect', (request, clientSocket, head) => {
			connects.push(request.url ?? '');
			const [host, port] = (request.url ?? '').split(':');
			const upstream = net.connect(Number(port), host, () => {
				clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
				upstream.write(head);
				upstream.pipe(clientSocket);
				clientSocket.pipe(upstream);
			});
			upstream.on('error', () => clientSocket.destroy());
			clientSocket.on('error', () => upstream.destroy());
		});
		await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
		proxyUrl = `http://127.0.0.1:${(proxy.address() as net.AddressInfo).port}`;
	});

	after(async () => {
		proxy.closeAllConnections();
		target.closeAllConnections();
		await new Promise(resolve => proxy.close(resolve));
		await new Promise(resolve => target.close(resolve));
	});

	it('sends page requests through the proxy and DB service requests directly', async () => {
		const { service, seed, close } = await openService();
		try {
			const url = 'https://crawl.bandcamp.com/track/proxied';
			await seed.item.insert(url);
			connects.length = 0;

			// the fake reader loads a local page with the HTTP client of its worker, which has the proxy
			const createReader = (client: HttpClient): PageReader => new FakeReader(async itemUrl => {
				const response = await client.get(`http://127.0.0.1:${targetPort}/page`);
				return itemData(itemUrl, { tags: { data: [response.body] } });
			});
			const counts = await runCrawler(config(service, { proxy: proxyUrl }), { createReader });

			assert.equal(counts.saved, 1);
			assert.deepEqual(await row(seed, 'items', url), { processed: 1, isBusy: 0, failedCount: 0 });
			const tags = await seed.query('SELECT name FROM tags WHERE name = ?', ['from-target']);
			assert.equal(tags.length, 1);

			// only the page request used the proxy, the DB service port is not in the list
			assert.deepEqual(connects, [`127.0.0.1:${targetPort}`]);
		} finally {
			await close();
		}
	});
});

describe('HttpCrawlTransport', () => {
	it('tries again after connection errors with a growing pause', async () => {
		let calls = 0;
		const server = http.createServer((request, response) => {
			calls++;
			if (calls <= 2) {
				request.socket.destroy();
				return;
			}
			response.setHeader('content-type', 'application/json');
			response.end(JSON.stringify({ ok: true }));
		});
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		const url = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;

		try {
			const pauses: number[] = [];
			const transport = new HttpCrawlTransport(url, { baseDelayMs: 100, sleep: async ms => { pauses.push(ms); } });
			assert.deepEqual(await transport.post('/x', {}), { ok: true });
			assert.deepEqual(pauses, [100, 200]);
		} finally {
			server.closeAllConnections();
			await new Promise(resolve => server.close(resolve));
		}
	});

	it('gives up after the last try and does not retry an error status', async () => {
		let attempts = 0;
		const failing = new HttpCrawlTransport('http://127.0.0.1:1', {
			maxAttempts: 3,
			sleep: async () => { attempts++; },
		});
		await assert.rejects(failing.post('/x', {}));
		assert.equal(attempts, 2);

		let calls = 0;
		const server = http.createServer((_request, response) => {
			calls++;
			response.statusCode = 500;
			response.setHeader('content-type', 'application/json');
			response.end(JSON.stringify({ message: 'store broke' }));
		});
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		try {
			const transport = new HttpCrawlTransport(`http://127.0.0.1:${(server.address() as net.AddressInfo).port}`, { sleep: async () => { } });
			await assert.rejects(transport.post('/x', {}), /HTTP 500: store broke/);
			assert.equal(calls, 1);
		} finally {
			server.closeAllConnections();
			await new Promise(resolve => server.close(resolve));
		}
	});
});

describe('RemoteCrawlStore lease', () => {
	it('extends the lease of a task in work until it is released', async () => {
		const routes: string[] = [];
		const transport: CrawlTransport = {
			post: async route => {
				routes.push(route);
				if (route === '/claim') {
					return { tasks: [{ id: 1, url: 'https://x.bandcamp.com/track/a', type: 'item' }] };
				}
				return route === '/extend-lease' ? { extended: true } : {};
			},
		};
		const store = new RemoteCrawlStore(transport, 20);
		const [task] = await store.claim(UrlType.Item, 1, false);

		await new Promise(resolve => setTimeout(resolve, 100));
		assert.ok(routes.filter(route => route === '/extend-lease').length >= 2);

		await store.release(task, 'failed');
		const after = routes.length;
		await new Promise(resolve => setTimeout(resolve, 80));
		assert.equal(routes.length, after);
		store.close();
	});
});

describe('crawler config', () => {
	it('reads the environment and the flags', () => {
		const fromEnv = readEnvConfig({
			CRAWLER_DB_URL: 'http://127.0.0.1:4100',
			CRAWLER_WORKERS: '3',
			CRAWLER_MIN_DELAY_MS: '10',
			CRAWLER_TYPE: 'item',
		}, ['--account', '--reverse']);
		const result = parseCrawlerConfig(fromEnv);
		assert.equal(result.type, 'account');
		assert.equal(result.reverse, true);
		assert.equal(result.workers, 3);
		assert.equal(result.minDelayMs, 10);
		assert.equal(result.proxy, undefined);
	});

	it('lets a later source win', () => {
		const result = parseCrawlerConfig(
			{ dbUrl: 'http://127.0.0.1:4100', type: 'item', workers: 1 },
			{ workers: 4, proxy: 'http://user:pass@127.0.0.1:8080' },
		);
		assert.equal(result.workers, 4);
		assert.equal(result.proxy, 'http://user:pass@127.0.0.1:8080');
	});

	it('reads the idle wait from the environment and an exit-when-empty value of 0', () => {
		assert.equal(readEnvConfig({ CRAWLER_IDLE_MS: '5000' }).idleMs, 5000);
		assert.equal(readEnvConfig({}).idleMs, undefined);
		assert.equal(toSpiderOptions(parseCrawlerConfig({ dbUrl: 'http://127.0.0.1:1', type: 'item' })).idleWaitMs, DEFAULT_IDLE_MS);
		assert.equal(toSpiderOptions(parseCrawlerConfig({ dbUrl: 'http://127.0.0.1:1', type: 'item', idleMs: 1000 })).idleWaitMs, 1000);
		assert.equal(toSpiderOptions(parseCrawlerConfig({ dbUrl: 'http://127.0.0.1:1', type: 'item', idleMs: 0 })).idleWaitMs, undefined);
	});

	it('refuses bad values without printing the proxy password', () => {
		assert.throws(() => parseCrawlerConfig({ type: 'item' }), /dbUrl/);
		assert.throws(() => parseCrawlerConfig({ dbUrl: 'http://127.0.0.1:1', type: 'x' }), /type/);
		assert.throws(() => parseCrawlerConfig({ dbUrl: 'http://127.0.0.1:1', type: 'item', workers: 0 }), /workers/);
		assert.throws(() => parseCrawlerConfig({ dbUrl: 'http://127.0.0.1:1', type: 'item', minDelayMs: 9, maxDelayMs: 1 }), /minDelayMs/);
		assert.throws(
			() => parseCrawlerConfig({ dbUrl: 'http://127.0.0.1:1', type: 'item', proxy: 'secret-pass' }),
			(error: Error) => /proxy/.test(error.message) && !error.message.includes('secret-pass'),
		);
	});
});

describe('crawler process', () => {
	const entry = path.join(__dirname, '..', 'index.js');

	/** Starts the entry point with fork and collects what it sends until it exits. */
	const runChild = (env: Record<string, string>, afterFork: (child: ReturnType<typeof fork>) => void = () => { }) =>
		new Promise<{ messages: Array<{ type: string, counts?: unknown }>, code: number | null }>((resolve, reject) => {
			const child = fork(entry, [], { cwd: tempDir, silent: true, env: { ...process.env, ...env } });
			const messages: Array<{ type: string }> = [];
			child.on('message', message => messages.push(message as { type: string }));
			child.once('error', reject);
			child.once('exit', code => resolve({ messages, code }));
			afterFork(child);
		});

	const noCounts = { claimed: 0, saved: 0, failed: 0, rateLimited: 0, notFound: 0 };

	it('takes its config from the environment and reports over IPC', async () => {
		// no items in the DB, so the crawler ends at once and never reaches Bandcamp
		const { service, close } = await openService();
		try {
			const { messages, code } = await runChild({ CRAWLER_DB_URL: service.url, CRAWLER_TYPE: 'item', CRAWLER_IDLE_MS: '0' });
			assert.equal(code, 0);
			assert.deepEqual(messages.map(m => m.type), ['started', 'metrics', 'stopped']);
			assert.deepEqual(messages[2].counts, noCounts);
		} finally {
			await close();
		}
	});

	it('takes its config from an IPC message when the environment has none', async () => {
		const { service, close } = await openService();
		try {
			const { messages, code } = await runChild({ CRAWLER_DB_URL: '' }, child => {
				child.send({ type: 'config', config: { dbUrl: service.url, type: 'item', workers: 2, idleMs: 0 } });
			});
			assert.equal(code, 0);
			assert.deepEqual(messages.map(m => m.type), ['started', 'metrics', 'stopped']);
		} finally {
			await close();
		}
	});

	it('exits with an error code when the config is wrong', async () => {
		const { code } = await runChild({ CRAWLER_DB_URL: 'not-a-url', CRAWLER_TYPE: 'item' });
		assert.equal(code, 1);
	});
});
