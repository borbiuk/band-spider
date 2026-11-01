import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { buildApp } from '../app';
import { JsonFileConfigStore } from '../config-store';
import { Supervisor } from '../supervisor';
import { CRAWLER_ENTRY, DB_ENTRY, FakeLauncher, readyDbLauncher } from './fakes';

const TOKEN = 'test-token';
const PORT = 4200;

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'band-spider-admin-api-'));
const configFile = path.join(tempDir, 'config.json');

let launcher: FakeLauncher;
let app: ReturnType<typeof buildApp>;

before(() => {
	launcher = readyDbLauncher();
	const configStore = new JsonFileConfigStore(configFile);
	const supervisor = new Supervisor({
		launcher,
		configStore,
		entries: { dbService: DB_ENTRY, crawler: CRAWLER_ENTRY },
		stopTimeoutMs: 50,
	});
	app = buildApp({ supervisor, configStore, security: { token: TOKEN, port: () => PORT } });
});

after(async () => {
	await app.close();
	fs.rmSync(tempDir, { recursive: true, force: true });
});

const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
	app.inject({
		method,
		url,
		payload: payload as object | undefined,
		headers: { host: `127.0.0.1:${PORT}`, authorization: `Bearer ${TOKEN}` },
	});

describe('admin API', () => {
	it('answers /health', async () => {
		const response = await call('GET', '/health');
		assert.deepEqual(response.json(), { status: 'ok' });
	});

	it('returns the default config, then saves a new one to the file', async () => {
		assert.deepEqual((await call('GET', '/config')).json(), { proxyPool: [], dbService: { port: 4100 }, crawlers: [] });

		const response = await call('PUT', '/config', {
			crawlers: [{ name: 'items', type: 'item' }, { name: 'accounts', type: 'account', workers: 2 }],
		});
		assert.equal(response.statusCode, 200);
		assert.equal(response.json().crawlers[1].workers, 2);
		assert.equal(JSON.parse(fs.readFileSync(configFile, 'utf8')).crawlers.length, 2);
		assert.equal((await call('GET', '/config')).json().crawlers[0].name, 'items');
	});

	it('refuses a bad config with 400 and a message', async () => {
		const response = await call('PUT', '/config', { crawlers: [{ name: 'a b', type: 'item' }] });
		assert.equal(response.statusCode, 400);
		assert.equal(typeof response.json().message, 'string');
		// the saved config is unchanged
		assert.equal((await call('GET', '/config')).json().crawlers.length, 2);
	});

	it('starts and stops the processes', async () => {
		const started = await call('POST', '/crawlers/items/start');
		assert.equal(started.statusCode, 200);
		const status = started.json();
		assert.equal(status.crawlers.find((item: { name: string }) => item.name === 'items').state, 'starting');
		assert.equal(status.db.state, 'running');

		launcher.of(CRAWLER_ENTRY)[0].emit({ type: 'started' });
		const running = (await call('GET', '/status')).json();
		assert.equal(running.crawlers[0].state, 'running');

		assert.equal((await call('POST', '/crawlers/items/start')).statusCode, 409);

		const stopped = (await call('POST', '/crawlers/items/stop')).json();
		assert.equal(stopped.crawlers[0].state, 'stopped');
	});

	it('returns logs and 404 for unknown crawlers', async () => {
		launcher.of(CRAWLER_ENTRY)[0].print('one\ntwo\nthree\n');
		const logs = (await call('GET', '/crawlers/items/logs?limit=2')).json();
		assert.deepEqual(logs, { lines: ['two', 'three'] });
		assert.deepEqual((await call('GET', '/db/logs')).json(), { lines: [] });

		assert.equal((await call('GET', '/crawlers/nope/logs')).statusCode, 404);
		assert.equal((await call('POST', '/crawlers/nope/start')).statusCode, 404);
		assert.equal((await call('GET', '/crawlers/items/logs?limit=0')).statusCode, 400);
	});

	it('controls the DB service and everything at once', async () => {
		const stopAll = (await call('POST', '/stop-all')).json();
		assert.equal(stopAll.db.state, 'stopped');

		const startAll = (await call('POST', '/start-all')).json();
		assert.equal(startAll.db.state, 'running');
		assert.deepEqual(startAll.crawlers.map((item: { state: string }) => item.state), ['starting', 'starting']);

		const before = launcher.of(DB_ENTRY).length;
		const restarted = (await call('POST', '/db/restart')).json();
		assert.ok(['starting', 'running'].includes(restarted.db.state));
		assert.equal(launcher.of(DB_ENTRY).length, before + 1);

		const stopped = (await call('POST', '/db/stop')).json();
		assert.equal(stopped.db.state, 'stopped');
		assert.deepEqual(stopped.crawlers.map((item: { state: string }) => item.state), ['stopped', 'stopped']);
	});
});
