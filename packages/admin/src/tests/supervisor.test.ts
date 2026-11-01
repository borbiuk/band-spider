import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AdminConfig, adminConfigSchema } from '../config';
import { ConfigStore } from '../config-store';
import { Supervisor, SupervisorOptions } from '../supervisor';
import { CRAWLER_ENTRY, DB_ENTRY, FakeLauncher, readyDbLauncher } from './fakes';

class MemoryConfigStore implements ConfigStore {
	constructor(public config: AdminConfig) {
	}

	async load(): Promise<AdminConfig> {
		return this.config;
	}

	async save(config: AdminConfig): Promise<void> {
		this.config = config;
	}
}

const COUNTS = { claimed: 2, saved: 1, failed: 0, rateLimited: 0, notFound: 0 };

const setup = (launcher: FakeLauncher = readyDbLauncher(), options: Partial<SupervisorOptions> = {}) => {
	const configStore = new MemoryConfigStore(adminConfigSchema.parse({
		dbService: { port: 4100, token: 'secret', leaseMs: 5000, dbFile: '/data/x.sqlite' },
		crawlers: [
			{ name: 'items', type: 'item', workers: 2, proxy: { kind: 'url', url: 'http://p:8080' } },
			{ name: 'accounts', type: 'account', reverse: true },
		],
	}));
	const supervisor = new Supervisor({
		launcher,
		configStore,
		entries: { dbService: DB_ENTRY, crawler: CRAWLER_ENTRY },
		dbStatsIntervalMs: 0,
		...options,
	});
	return { launcher, configStore, supervisor };
};

describe('Supervisor', () => {
	it('starts the DB service with its settings and tracks it from the ready message', async () => {
		const { launcher, supervisor } = setup();
		await supervisor.startDb();
		await new Promise(resolve => setImmediate(resolve));

		const status = (await supervisor.status()).db;
		assert.equal(status.state, 'running');
		assert.equal(status.url, 'http://127.0.0.1:4100');
		const env = launcher.children[0].spec.env;
		assert.equal(env?.DB_SERVICE_PORT, '4100');
		assert.equal(env?.DB_SERVICE_TOKEN, 'secret');
		assert.equal(env?.DB_SERVICE_LEASE_MS, '5000');
		assert.equal(env?.BAND_DB_PATH, '/data/x.sqlite');
		await assert.rejects(supervisor.startDb(), /Already running/);
	});

	it('starts a crawler only after the DB service is ready, and sends the config over IPC', async () => {
		const launcher = new FakeLauncher();
		const { supervisor } = setup(launcher);
		const starting = supervisor.startCrawler('items');
		await new Promise(resolve => setImmediate(resolve));

		// the DB service is up but not ready, so no crawler exists yet
		assert.equal(launcher.of(DB_ENTRY).length, 1);
		assert.equal(launcher.of(CRAWLER_ENTRY).length, 0);
		assert.equal((await supervisor.status()).crawlers[0].state, 'starting');
		await assert.rejects(supervisor.startCrawler('items'), /Already starting/);

		launcher.of(DB_ENTRY)[0].emit({ type: 'ready', url: 'http://127.0.0.1:5555' });
		await starting;

		const crawler = launcher.of(CRAWLER_ENTRY)[0];
		assert.equal('CRAWLER_DB_URL' in (crawler.spec.env ?? {}), true);
		assert.equal(crawler.spec.env?.CRAWLER_DB_URL, undefined);
		assert.deepEqual(crawler.sent[0], {
			type: 'config',
			config: {
				dbUrl: 'http://127.0.0.1:5555',
				token: 'secret',
				type: 'item',
				reverse: false,
				workers: 2,
				minDelayMs: undefined,
				maxDelayMs: undefined,
				proxy: 'http://p:8080',
			},
		});
	});

	it('starts the DB service by itself when a crawler starts', async () => {
		const { launcher, supervisor } = setup();
		await supervisor.startCrawler('accounts');
		assert.equal(launcher.of(DB_ENTRY).length, 1);
		assert.equal(launcher.of(CRAWLER_ENTRY).length, 1);
	});

	it('tracks a crawler from its IPC messages', async () => {
		const { launcher, supervisor } = setup();
		await supervisor.startCrawler('items');
		const crawler = launcher.of(CRAWLER_ENTRY)[0];

		crawler.emit({ type: 'started' });
		crawler.emit({ type: 'progress', counts: COUNTS });
		crawler.emit({ type: 'nonsense' });
		let status = (await supervisor.status()).crawlers.find(item => item.name === 'items');
		assert.equal(status?.state, 'running');
		assert.deepEqual(status?.counts, COUNTS);
		assert.equal(status?.pid, crawler.pid);

		// the crawler finishes its work on its own
		crawler.emit({ type: 'stopped', counts: COUNTS });
		crawler.exit(0);
		status = (await supervisor.status()).crawlers.find(item => item.name === 'items');
		assert.equal(status?.state, 'stopped');
		assert.equal(status?.pid, undefined);
		assert.deepEqual(status?.counts, COUNTS);
	});

	it('marks a crawler as failed on an error report or an unexpected exit', async () => {
		const { launcher, supervisor } = setup();
		await supervisor.startCrawler('items');
		await supervisor.startCrawler('accounts');
		const [items, accounts] = launcher.of(CRAWLER_ENTRY);

		items.emit({ type: 'stopped', counts: COUNTS, error: 'DB service is down' });
		items.exit(1);
		accounts.exit(3);

		const { crawlers } = await supervisor.status();
		assert.deepEqual(crawlers.map(item => [item.name, item.state, item.error]), [
			['items', 'failed', 'DB service is down'],
			['accounts', 'failed', 'Exited with code 3'],
		]);
	});

	it('stops a crawler with a stop message and can start it again', async () => {
		const { launcher, supervisor } = setup();
		await supervisor.startCrawler('items');
		await supervisor.stopCrawler('items');
		assert.deepEqual(launcher.of(CRAWLER_ENTRY)[0].sent[1], { type: 'stop' });
		assert.equal((await supervisor.status()).crawlers[0].state, 'stopped');

		await supervisor.restartCrawler('items');
		assert.equal(launcher.of(CRAWLER_ENTRY).length, 2);
	});

	it('kills a child that does not stop in time', async () => {
		const { launcher, supervisor } = setup(readyDbLauncher(), { stopTimeoutMs: 20 });
		await supervisor.startCrawler('items');
		const crawler = launcher.of(CRAWLER_ENTRY)[0];
		crawler.onStopRequest = () => undefined;

		await supervisor.stopCrawler('items');
		assert.deepEqual(crawler.signals, ['SIGKILL']);
		assert.equal((await supervisor.status()).crawlers[0].state, 'stopped');
	});

	it('stops the crawlers before the DB service, with SIGTERM for the service', async () => {
		const { launcher, supervisor } = setup();
		const order: string[] = [];
		await supervisor.startAll();
		for (const child of launcher.children) {
			const original = child.onStopRequest;
			child.onStopRequest = () => {
				order.push(child.spec.entry);
				original();
			};
		}
		await supervisor.stopAll();

		assert.equal(launcher.of(CRAWLER_ENTRY).length, 2);
		assert.deepEqual(order, [CRAWLER_ENTRY, CRAWLER_ENTRY, DB_ENTRY]);
		assert.deepEqual(launcher.of(DB_ENTRY)[0].signals, ['SIGTERM']);
		const status = await supervisor.status();
		assert.equal(status.db.state, 'stopped');
		assert.deepEqual(status.crawlers.map(item => item.state), ['stopped', 'stopped']);
	});

	it('shutdown leaves no child running', async () => {
		const { launcher, supervisor } = setup();
		await supervisor.startAll();
		await supervisor.shutdown();
		assert.equal(launcher.children.length, 3);
		assert.equal((await supervisor.status()).db.state, 'stopped');
	});

	it('restarts the DB service without stopping the crawlers', async () => {
		const { launcher, supervisor } = setup();
		await supervisor.startCrawler('items');
		await supervisor.restartDb();
		assert.equal(launcher.of(DB_ENTRY).length, 2);
		assert.equal(launcher.of(CRAWLER_ENTRY)[0].signals.length + launcher.of(CRAWLER_ENTRY)[0].sent.filter(m => (m as { type: string }).type === 'stop').length, 0);
	});

	it('fails a crawler start when the DB service never gets ready', async () => {
		const { launcher, supervisor } = setup(new FakeLauncher(), { readyTimeoutMs: 20 });
		await assert.rejects(supervisor.startCrawler('items'), /not ready/);
		assert.equal(launcher.of(CRAWLER_ENTRY).length, 0);
		const crawler = (await supervisor.status()).crawlers[0];
		assert.equal(crawler.state, 'failed');
	});

	it('fails a crawler start when the DB service exits first', async () => {
		const launcher = new FakeLauncher();
		launcher.onLaunch = child => child.exit(1);
		const { supervisor } = setup(launcher);
		await assert.rejects(supervisor.startCrawler('items'), /not ready/);
		assert.equal((await supervisor.status()).db.state, 'failed');
	});

	it('keeps the output of each child in its own buffer', async () => {
		const { launcher, supervisor } = setup();
		await supervisor.startCrawler('items');
		launcher.of(DB_ENTRY)[0].print('db line\n');
		launcher.of(CRAWLER_ENTRY)[0].print('crawler line 1\ncrawler li');
		launcher.of(CRAWLER_ENTRY)[0].print('ne 2\n', 'stderr');

		assert.deepEqual(supervisor.dbLogs(), ['db line']);
		assert.deepEqual(supervisor.crawlerLogs('items'), ['crawler line 1', 'crawler line 2']);
		assert.throws(() => supervisor.crawlerLogs('accounts'), /No crawler/);
	});

	it('refuses an unknown crawler', async () => {
		const { supervisor } = setup();
		await assert.rejects(supervisor.startCrawler('nope'), /No crawler nope/);
		await assert.rejects(supervisor.stopCrawler('nope'), /No crawler nope/);
	});

	it('uses the config at the time of the start', async () => {
		const { launcher, configStore, supervisor } = setup();
		configStore.config = adminConfigSchema.parse({
			dbService: { port: 0 },
			crawlers: [{ name: 'items', type: 'item', workers: 5 }],
		});
		await supervisor.startCrawler('items');
		const config = (launcher.of(CRAWLER_ENTRY)[0].sent[0] as { config: { workers: number } }).config;
		assert.equal(config.workers, 5);
		assert.equal(launcher.of(DB_ENTRY)[0].spec.env?.DB_SERVICE_PORT, '0');
	});
});
