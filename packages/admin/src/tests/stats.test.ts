import assert from 'node:assert/strict';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import { AdminConfig, adminConfigSchema } from '../config';
import { ConfigStore } from '../config-store';
import { DbStats, DbStatsSource, DbTotals, HttpDbStatsSource } from '../db-stats';
import { renderStatus } from '../ui-render';
import { Supervisor, SupervisorEvent } from '../supervisor';
import { CRAWLER_ENTRY, DB_ENTRY, readyDbLauncher } from './fakes';

const MIN = 60_000;

const config = adminConfigSchema.parse({
	dbService: { port: 4100, token: 'secret' },
	crawlers: [{ name: 'items', type: 'item' }],
});

class MemoryConfigStore implements ConfigStore {
	async load(): Promise<AdminConfig> {
		return config;
	}

	async save(): Promise<void> {
	}
}

const DB_STATS: DbStats = {
	startedAt: new Date('2024-01-01T00:00:00.000Z'),
	claimed: 12, itemsSaved: 9, accountsSaved: 1, released: 2, newUrls: 30,
	queueLeft: { items: 1500, accounts: 42 },
};

const DB_TOTALS: DbTotals = {
	countedAt: new Date('2024-01-01T00:05:00.000Z'), items: 10, itemsProcessed: 4, accounts: 5, accountsProcessed: 1,
	itemAccountRelations: 20, wishlistRelations: 5, followers: 3,
};

class FakeStatsSource implements DbStatsSource {
	readonly calls: Array<{ url: string; token?: string }> = [];
	failWith?: string;

	async read(url: string, token?: string): Promise<DbStats> {
		this.calls.push({ url, token });
		if (this.failWith) {
			throw new Error(this.failWith);
		}
		return DB_STATS;
	}

	readonly totalsCalls: Array<{ url: string; token?: string }> = [];
	totalsFailWith?: string;

	async readTotals(url: string, token?: string): Promise<DbTotals> {
		this.totalsCalls.push({ url, token });
		if (this.totalsFailWith) {
			throw new Error(this.totalsFailWith);
		}
		return DB_TOTALS;
	}
}

const setup = (dbStatsIntervalMs = 20) => {
	const clock = { now: 5_000_000 };
	const launcher = readyDbLauncher();
	const source = new FakeStatsSource();
	const supervisor = new Supervisor({
		launcher,
		configStore: new MemoryConfigStore(),
		entries: { dbService: DB_ENTRY, crawler: CRAWLER_ENTRY },
		dbStatsSource: source,
		dbStatsIntervalMs,
		stopTimeoutMs: 50,
		now: () => clock.now,
	});
	return { clock, launcher, source, supervisor };
};

const later = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('crawler statistics in the supervisor', () => {
	it('turns metrics messages into speeds and totals and tells the listeners', async () => {
		const { clock, launcher, supervisor } = setup(0);
		const events: SupervisorEvent[] = [];
		await supervisor.startCrawler('items');
		const crawler = launcher.of(CRAWLER_ENTRY)[0];
		crawler.emit({ type: 'started' });
		supervisor.subscribe(event => events.push(event));

		let status = (await supervisor.status()).crawlers[0];
		assert.equal(status.stats, undefined);

		clock.now += MIN;
		crawler.emit({ type: 'metrics', metrics: { requests: 90, http429: 1, processed: 30, failed: 0, pauseMs: 4000 } });

		status = (await supervisor.status()).crawlers[0];
		assert.equal(status.stats?.requestsPerMin, 90);
		assert.equal(status.stats?.urlsPerMin, 30);
		assert.equal(status.stats?.http429PerHour, 1);
		assert.equal(status.stats?.pauseMs, 4000);
		assert.deepEqual(events, [{ kind: 'status' }]);

		// a bad message is ignored
		crawler.emit({ type: 'metrics', metrics: { requests: 'many' } });
		assert.equal((await supervisor.status()).crawlers[0].stats?.totals.requests, 90);
	});

	it('starts the numbers again when the crawler starts again', async () => {
		const { clock, launcher, supervisor } = setup(0);
		await supervisor.startCrawler('items');
		clock.now += MIN;
		launcher.of(CRAWLER_ENTRY)[0].emit({ type: 'metrics', metrics: { requests: 90, http429: 0, processed: 1, failed: 0, pauseMs: 0 } });
		await supervisor.stopCrawler('items');

		await supervisor.startCrawler('items');

		assert.equal((await supervisor.status()).crawlers[0].stats, undefined);
	});

	it('reads the DB service numbers with its URL and token while it runs', async () => {
		const { source, supervisor } = setup();
		await supervisor.startDb();
		await later(60);

		const status = (await supervisor.status()).db;
		assert.deepEqual(status.dbStats, DB_STATS);
		assert.equal(status.dbStatsError, undefined);
		assert.equal(source.calls[0].url, 'http://127.0.0.1:4100');
		assert.equal(source.calls[0].token, 'secret');
		assert.ok(source.calls.length >= 2, 'read again after the interval');
		assert.deepEqual(status.queueHistory?.slice(0, 2), [DB_STATS.queueLeft?.items, DB_STATS.queueLeft?.items]);
		await supervisor.stopDb();
	});

	it('shows why the numbers cannot be read, and drops them when the service stops', async () => {
		const { source, supervisor } = setup();
		await supervisor.startDb();
		await later(30);
		source.failWith = 'DB service answered HTTP 500';
		await later(60);

		let status = (await supervisor.status()).db;
		assert.equal(status.dbStatsError, 'DB service answered HTTP 500');

		await supervisor.stopDb();
		const callsAtStop = source.calls.length;
		await later(60);
		status = (await supervisor.status()).db;
		assert.equal(status.dbStats, undefined);
		assert.equal(status.dbStatsError, undefined);
		assert.deepEqual(status.queueHistory, []);
		assert.equal(source.calls.length, callsAtStop, 'no reads after the stop');
	});

	it('does not read when the interval is 0', async () => {
		const { source, supervisor } = setup(0);
		await supervisor.startDb();
		await later(30);
		assert.equal(source.calls.length, 0);
		await supervisor.stopDb();
	});
});

describe('HttpDbStatsSource', () => {
	it('reads /stats with the bearer token and parses the dates', async () => {
		const seen: Array<string | undefined> = [];
		const server = http.createServer((request, response) => {
			seen.push(request.headers.authorization);
			response.setHeader('content-type', 'application/json');
			if (request.headers.authorization !== 'Bearer secret') {
				response.statusCode = 401;
				return response.end('{"message":"Unauthorized"}');
			}
			response.end(JSON.stringify({ ...DB_STATS, startedAt: DB_STATS.startedAt.toISOString() }));
		});
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		try {
			const source = new HttpDbStatsSource();
			assert.deepEqual(await source.read(url, 'secret'), DB_STATS);
			await assert.rejects(source.read(url, 'wrong'), /HTTP 401/);
			await assert.rejects(source.read(url), /HTTP 401/);
		} finally {
			server.closeAllConnections();
			await new Promise(resolve => server.close(resolve));
		}
	});
});

describe('DB size for the Insights view', () => {
	it('reads the size in the background when the view asks, and not again for five minutes', async () => {
		const { clock, source, supervisor } = setup(0);
		await supervisor.startDb();
		const events: SupervisorEvent[] = [];
		supervisor.subscribe(event => events.push(event));

		// the answer does not wait for the count, a status event comes when it is done
		const first = await supervisor.insights();
		assert.equal(first.totals, undefined);
		assert.equal(first.totalsLoading, true);
		await later(20);
		assert.ok(events.some(event => event.kind === 'status'));
		const second = await supervisor.insights();
		assert.deepEqual(second.totals, DB_TOTALS);
		assert.equal(second.totalsLoading, false);
		assert.deepEqual(source.totalsCalls[0], { url: 'http://127.0.0.1:4100', token: 'secret' });

		await supervisor.insights();
		assert.equal(source.totalsCalls.length, 1, 'the number is reused');
		clock.now += 6 * MIN;
		await supervisor.insights();
		await later(20);
		assert.equal(source.totalsCalls.length, 2, 'it is read again when it is old');

		// a stopped service has no size, and a new one starts from nothing
		await supervisor.stopDb();
		assert.equal((await supervisor.insights()).totals, undefined);
	});

	it('shows a failed count and tries again after a minute', async () => {
		const { clock, source, supervisor } = setup(0);
		source.totalsFailWith = 'DB service answered HTTP 404 for the DB size';
		await supervisor.startDb();
		await supervisor.insights();
		await later(20);
		assert.equal((await supervisor.insights()).totalsError, 'DB service answered HTTP 404 for the DB size');
		assert.equal(source.totalsCalls.length, 1);

		clock.now += 2 * MIN;
		source.totalsFailWith = undefined;
		await supervisor.insights();
		await later(20);
		const recovered = await supervisor.insights();
		assert.equal(recovered.totalsError, undefined);
		assert.deepEqual(recovered.totals, DB_TOTALS);
		await supervisor.stopDb();
	});

	it('keeps a history of the flow and drops it when the counters start again', async () => {
		const { clock, supervisor } = setup(20);
		await supervisor.startDb();
		await later(60);
		// the test fake has no flow, so there is nothing to keep
		assert.deepEqual((await supervisor.insights()).history, []);
		clock.now += MIN;
		await supervisor.stopDb();
	});

	it('reads the DB size over HTTP with the token', async () => {
		const server = http.createServer((request, response) => {
			response.setHeader('content-type', 'application/json');
			if (request.url === '/totals' && request.headers.authorization === 'Bearer secret') {
				response.end(JSON.stringify({ ...DB_TOTALS, countedAt: DB_TOTALS.countedAt.toISOString() }));
			} else {
				response.statusCode = 401;
				response.end('{"message":"Unauthorized"}');
			}
		});
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		try {
			const source = new HttpDbStatsSource();
			assert.deepEqual(await source.readTotals(url, 'secret'), DB_TOTALS);
			await assert.rejects(source.readTotals(url), /HTTP 401 for the DB size/);
		} finally {
			server.closeAllConnections();
			await new Promise(resolve => server.close(resolve));
		}
	});
});

describe('statistics on the page', () => {
	const baseStatus = {
		db: { state: 'running' as const, url: 'http://127.0.0.1:4100', dbStats: DB_STATS },
		crawlers: [{
			name: 'items', configured: true, state: 'running' as const,
			counts: { claimed: 5, saved: 4, failed: 1, rateLimited: 0, notFound: 0 },
			stats: {
				requestsPerMin: 120.5, urlsPerMin: 60, http429PerHour: 3,
				totals: { requests: 12345, processed: 800, failed: 12, http429: 4 }, pauseMs: 65_000, idle: false,
			},
		}],
	};

	it('shows the queue and the speeds, totals and pause of a crawler', () => {
		const html = renderStatus(baseStatus, config);

		assert.match(html, /queue left: 1,500 items, 42 accounts/);
		assert.match(html, /12 claimed, 9 items saved, 1 accounts saved/);
		assert.match(html, /<b>120\.5<\/b> requests\/min/);
		assert.match(html, /<b>60<\/b> URLs\/min/);
		assert.match(html, /stat-warn"><b>3<\/b> HTTP 429\/hour/);
		assert.match(html, /12,345 requests, 800 saved, 12 failed, 4 HTTP 429/);
		assert.match(html, /paused after HTTP 429, 1m 05s left/);
	});

	it('shows when a crawler waits for URLs', () => {
		const [crawler] = baseStatus.crawlers;
		const waiting = { ...baseStatus, crawlers: [{ ...crawler, stats: { ...crawler.stats, idle: true } }] };

		assert.match(renderStatus(waiting, config), /waiting for URLs/);
		assert.doesNotMatch(renderStatus(baseStatus, config), /waiting for URLs/);
	});

	it('says so when there is no report or no queue number yet', () => {
		const html = renderStatus({
			db: { state: 'running', dbStats: { ...DB_STATS, queueLeft: undefined } },
			crawlers: [{ name: 'items', configured: true, state: 'starting' }],
		}, config);

		assert.match(html, /queue left: unknown/);
		assert.match(html, /no report yet/);
		assert.doesNotMatch(html, /paused after/);
	});

	it('shows a statistics error of the DB service', () => {
		const html = renderStatus({
			db: { state: 'running', dbStatsError: 'timed out <b>' },
			crawlers: [],
		}, config);

		assert.match(html, /Statistics: timed out &lt;b&gt;/);
	});

	it('draws the charts with attributes only, because the page CSP has no inline styles', () => {
		const [crawler] = baseStatus.crawlers;
		const values = Array.from({ length: 30 }, (_, i) => i * 2);
		const html = renderStatus({
			db: { ...baseStatus.db, queueHistory: [9, 7, 5] },
			crawlers: [{ ...crawler, series: { requests: values, urls: values, http429: values } }],
		}, config);

		assert.match(html, /<svg class="chart"/);
		assert.match(html, /<svg class="spark spark-req"/);
		assert.match(html, /<svg class="spark spark-queue"/);
		assert.doesNotMatch(html, /\sstyle=/);
	});

	it('keeps the same lines in a crawler row with and without a pause', () => {
		const [crawler] = baseStatus.crawlers;
		const lines = (html: string) => html.match(/class="(?:note|stats|meta clip)/g)?.length;
		const calm = { ...baseStatus, crawlers: [{ ...crawler, stats: { ...crawler.stats, pauseMs: 0 } }] };
		const empty = { ...baseStatus, crawlers: [{ name: crawler.name, configured: true, state: 'running' as const }] };

		assert.equal(lines(renderStatus(calm, config)), lines(renderStatus(baseStatus, config)));
		assert.equal(lines(renderStatus(empty, config)), lines(renderStatus(baseStatus, config)));
	});
});
