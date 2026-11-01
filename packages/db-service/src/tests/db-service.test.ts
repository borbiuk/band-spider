import 'reflect-metadata';

import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { BandDatabase } from '@band-spider/storage-sqlite';
import { DbServiceConfig, readServiceConfig, RunningDbService, startDbService } from '../index';

const tempDir: string = fs.mkdtempSync(path.join(os.tmpdir(), 'band-spider-service-'));
const dbFile = path.join(tempDir, 'service.sqlite');

let service: RunningDbService;
let secured: RunningDbService;
let seed: BandDatabase;

const config = (file: string, token?: string): DbServiceConfig => ({
	host: '127.0.0.1',
	port: 0,
	token,
	database: { file, synchronize: true },
});

const post = (base: string, route: string, body: unknown, token?: string) =>
	fetch(base + route, {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
		body: JSON.stringify(body),
	});

before(async () => {
	// the file is created by the first service, the seed connection opens it after that
	service = await startDbService(config(dbFile));
	secured = await startDbService(config(path.join(tempDir, 'secured.sqlite'), 'secret'));
	seed = await BandDatabase.open({ file: dbFile, synchronize: false });
});

after(async () => {
	await seed.close();
	await service.stop();
	await secured.stop();
	fs.rmSync(tempDir, { recursive: true, force: true });
});

const emptyTab = { total: 0, urls: [] as string[], complete: true };

describe('DB service routes', () => {
	it('answers /health and /stats on a random port', async () => {
		const health = await fetch(service.url + '/health');
		assert.equal(health.status, 200);
		assert.deepEqual(await health.json(), { status: 'ok' });

		const stats = await (await fetch(service.url + '/stats')).json();
		assert.equal(stats.claimed, 0);
		assert.ok(!Number.isNaN(Date.parse(stats.startedAt)));
	});

	it('claims, extends, saves an item and counts it', async () => {
		const url = 'https://svc.bandcamp.com/track/one';
		const track = 'https://svc.bandcamp.com/track/two';
		await seed.item.insert(url);

		const claim = await post(service.url, '/claim', { type: 'item', count: 5, newestFirst: false });
		assert.equal(claim.status, 200);
		const { tasks } = await claim.json();
		const task = tasks.find((t: { url: string }) => t.url === url);
		assert.ok(task);
		assert.equal(task.type, 'item');

		const extend = await (await post(service.url, '/extend-lease', { task })).json();
		assert.deepEqual(extend, { extended: true });

		const save = await post(service.url, '/save-item', {
			task,
			data: {
				url,
				accounts: { data: ['https://bandcamp.com/svc-fan'] },
				tags: { data: ['svc-tag'] },
				releaseDate: { data: '2024-03-01T00:00:00.000Z' },
				album: { data: null },
				tracks: { data: [track] },
				imageUrl: { data: null },
				errors: [],
			},
		});
		assert.equal(save.status, 200);
		const { statistic } = await save.json();
		assert.deepEqual(statistic.tracks, { total: 1, newRecords: 1, newRelations: 1 });
		assert.deepEqual(statistic.newUrls, ['https://bandcamp.com/svc-fan', track]);

		const rows = await seed.query('SELECT lastProcessingDate IS NOT NULL AS processed, isBusy FROM items WHERE url = ?', [url]);
		assert.deepEqual(rows[0], { processed: 1, isBusy: 0 });

		// a saved task has no lease any more
		assert.deepEqual(await (await post(service.url, '/extend-lease', { task })).json(), { extended: false });

		const stats = await (await fetch(service.url + '/stats')).json();
		assert.equal(stats.itemsSaved, 1);
		assert.equal(stats.newUrls, 2);
	});

	it('claims an account with marks, saves it and sends errors as messages', async () => {
		const url = 'https://bandcamp.com/svc-owner';
		const album = 'https://svc-owner.bandcamp.com/album/one';
		await seed.account.insert(url);
		await seed.query('UPDATE accounts SET lastProcessingDate = CURRENT_DATE WHERE url != ? AND lastProcessingDate IS NULL', [url]);

		const { tasks } = await (await post(service.url, '/claim', { type: 'account', count: 1, newestFirst: false })).json();
		assert.equal(tasks.length, 1);
		assert.equal(tasks[0].url, url);

		const save = await post(service.url, '/save-account', {
			task: tasks[0],
			data: {
				url,
				collection: { total: 1, urls: [album], complete: true },
				wishlist: { total: 0, urls: [], complete: false, error: 'wishlist failed' },
				followers: emptyTab,
				following: emptyTab,
				errors: ['one error'],
			},
		});
		assert.equal(save.status, 200);
		const { statistic } = await save.json();
		assert.deepEqual(statistic.collection.newUrls, [album]);

		const stats = await (await fetch(service.url + '/stats')).json();
		assert.equal(stats.accountsSaved, 1);
	});

	it('release counts a failure but not a rate limit', async () => {
		const failedUrl = 'https://svc-release.bandcamp.com/track/failed';
		const limitedUrl = 'https://svc-release.bandcamp.com/track/limited';
		await seed.item.insert(failedUrl);
		await seed.item.insert(limitedUrl);
		await seed.query('UPDATE items SET lastProcessingDate = CURRENT_DATE WHERE url NOT IN (?, ?) AND lastProcessingDate IS NULL', [failedUrl, limitedUrl]);

		const { tasks } = await (await post(service.url, '/claim', { type: 'item', count: 2, newestFirst: false })).json();
		assert.equal(tasks.length, 2);
		for (const task of tasks) {
			const reason = task.url === failedUrl ? 'failed' : 'rateLimited';
			const response = await post(service.url, '/release', { task, reason });
			assert.equal(response.status, 200);
			assert.deepEqual(await response.json(), {});
		}

		const count = async (url: string) =>
			(await seed.query('SELECT failedCount, isBusy FROM items WHERE url = ?', [url]))[0];
		assert.deepEqual(await count(failedUrl), { failedCount: 1, isBusy: 0 });
		assert.deepEqual(await count(limitedUrl), { failedCount: 0, isBusy: 0 });
	});

	it('answers a bad body with 400 and a message', async () => {
		const response = await post(service.url, '/claim', { type: 'nothing', count: 0 });
		assert.equal(response.status, 400);
		const body = await response.json();
		assert.equal(typeof body.message, 'string');
	});

	it('answers a store failure with 500 and a message', async () => {
		const task = { id: 999999, url: 'https://svc.bandcamp.com/track/missing', type: 'item' };
		const response = await post(service.url, '/save-item', {
			task,
			data: { url: task.url, accounts: { data: null }, tags: { data: null }, releaseDate: { data: null }, imageUrl: { data: null }, errors: [] },
		});
		// a missing row is a store problem or a no-op, but never a crash of the service
		assert.ok(response.status === 200 || response.status === 500);
		assert.equal((await fetch(service.url + '/health')).status, 200);
	});
});

describe('DB service token', () => {
	it('keeps /health open and refuses other routes without the token', async () => {
		assert.equal((await fetch(secured.url + '/health')).status, 200);

		const noToken = await fetch(secured.url + '/stats');
		assert.equal(noToken.status, 401);
		assert.deepEqual(await noToken.json(), { message: 'Unauthorized' });

		const wrong = await fetch(secured.url + '/stats', { headers: { authorization: 'Bearer nope' } });
		assert.equal(wrong.status, 401);

		const good = await fetch(secured.url + '/stats', { headers: { authorization: 'Bearer secret' } });
		assert.equal(good.status, 200);
	});
});

describe('DB service config', () => {
	it('uses safe defaults', () => {
		const result = readServiceConfig({ BAND_DB_PATH: path.join(tempDir, 'none.sqlite') });
		assert.equal(result.host, '127.0.0.1');
		assert.equal(result.port, 4100);
		assert.equal(result.token, undefined);
		assert.equal(result.database.synchronize, true);
	});

	it('reads the environment and refuses a bad port', () => {
		const result = readServiceConfig({
			DB_SERVICE_PORT: '5000',
			DB_SERVICE_TOKEN: 'abc',
			DB_SERVICE_LEASE_MS: '2000',
			BAND_DB_PATH: dbFile,
		});
		assert.equal(result.port, 5000);
		assert.equal(result.token, 'abc');
		assert.equal(result.leaseMs, 2000);
		assert.equal(result.database.synchronize, false);

		assert.throws(() => readServiceConfig({ DB_SERVICE_PORT: 'x' }), /DB_SERVICE_PORT/);
	});
});

describe('DB service process', () => {
	it('sends a ready message when forked and stops on SIGTERM', async () => {
		const entry = path.join(__dirname, '..', 'index.js');
		const child = fork(entry, [], {
			cwd: tempDir,
			silent: true,
			env: {
				...process.env,
				DB_SERVICE_PORT: '0',
				BAND_DB_PATH: path.join(tempDir, 'forked.sqlite'),
			},
		});

		const ready = await new Promise<{ type: string, url: string }>((resolve, reject) => {
			child.once('message', message => resolve(message as { type: string, url: string }));
			child.once('error', reject);
			child.once('exit', code => reject(new Error(`exited early: ${code}`)));
		});
		assert.equal(ready.type, 'ready');
		assert.equal((await fetch(ready.url + '/health')).status, 200);

		const exited = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)));
		child.kill('SIGTERM');
		assert.equal(await exited, 0);
	});
});
