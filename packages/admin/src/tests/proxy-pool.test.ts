import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';
import { buildApp } from '../app';
import { adminConfigSchema } from '../config';
import { JsonFileConfigStore } from '../config-store';
import { maskConfig, restoreSecrets, SECRET_MASK } from '../secrets';
import { SESSION_COOKIE } from '../security';
import { Supervisor } from '../supervisor';
import { CRAWLER_ENTRY, DB_ENTRY, readyDbLauncher } from './fakes';

const TOKEN = 'test-token';
const PORT = 4201;
const PASS = 'zz-secret-pass-1';
const PASS2 = 'zz-secret-pass-2';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'band-spider-admin-pool-'));
const configFile = path.join(tempDir, 'config.json');
const configStore = new JsonFileConfigStore(configFile);
const launcher = readyDbLauncher();
const supervisor = new Supervisor({
	launcher,
	configStore,
	entries: { dbService: DB_ENTRY, crawler: CRAWLER_ENTRY },
	stopTimeoutMs: 50,
	dbStatsIntervalMs: 0,
});
const app = buildApp({ supervisor, configStore, security: { token: TOKEN, port: () => PORT } });

after(async () => {
	await supervisor.shutdown();
	await app.close();
	fs.rmSync(tempDir, { recursive: true, force: true });
});

const origin = `http://127.0.0.1:${PORT}`;
const headers = { host: `127.0.0.1:${PORT}`, cookie: `${SESSION_COOKIE}=${TOKEN}` };
const get = (url: string) => app.inject({ method: 'GET', url, headers });
const sendJson = (method: 'POST' | 'DELETE' | 'PUT', url: string, payload?: unknown) =>
	app.inject({ method, url, headers: { ...headers, origin }, payload: payload as object });
const postForm = (url: string, form: Record<string, string>) =>
	app.inject({
		method: 'POST',
		url,
		headers: { ...headers, origin, 'content-type': 'application/x-www-form-urlencoded' },
		payload: new URLSearchParams(form).toString(),
	});
const del = (url: string) => app.inject({ method: 'DELETE', url, headers: { ...headers, origin } });
const saved = () => JSON.parse(fs.readFileSync(configFile, 'utf8'));

const LIST = `10.0.0.1:6014:user1:${PASS}\r\n10.0.0.2:6641:user1:${PASS}\r\n`;

/** A fresh config with an empty pool and no crawlers. */
beforeEach(async () => {
	await configStore.save(adminConfigSchema.parse({}));
});

const importList = (text: string, mode?: string) => sendJson('POST', '/proxies/import', { text, mode });
const addPoolCrawler = (name: string, key: string, original = '') =>
	postForm('/fragments/crawlers', { original, name, type: 'item', workers: '1', proxyKind: 'pool', poolKey: key });

describe('pool config', () => {
	const config = adminConfigSchema.parse({
		proxyPool: [{ host: '10.0.0.1', port: 80, username: 'u', password: PASS }],
		crawlers: [{ name: 'a', type: 'item', proxy: { kind: 'pool', key: '10.0.0.1:80' } }],
	});

	it('defaults to an empty pool and refuses a duplicate host:port', () => {
		assert.deepEqual(adminConfigSchema.parse({}).proxyPool, []);
		const entry = { host: 'h', port: 1, username: 'u', password: 'p' };
		assert.equal(adminConfigSchema.safeParse({ proxyPool: [entry, { ...entry, username: 'x' }] }).success, false);
		assert.equal(adminConfigSchema.safeParse({ crawlers: [{ name: 'a', type: 'item', proxy: { kind: 'pool', key: '' } }] }).success, false);
	});

	it('masks the pool passwords', () => {
		const masked = maskConfig(config);
		assert.equal(masked.proxyPool[0].password, SECRET_MASK);
		assert.equal(masked.proxyPool[0].username, 'u');
		assert.doesNotMatch(JSON.stringify(masked), new RegExp(PASS));
	});

	it('restores a masked password by key and refuses one with no saved value', () => {
		const restored = restoreSecrets(maskConfig(config), config);
		assert.equal(restored.proxyPool[0].password, PASS);
		// a new password is kept
		const changed = maskConfig(config);
		changed.proxyPool[0].password = PASS2;
		assert.equal(restoreSecrets(changed, config).proxyPool[0].password, PASS2);
		assert.throws(() => restoreSecrets(maskConfig(config), adminConfigSchema.parse({})), /pool proxy 10\.0\.0\.1:80/);
	});

	it('hides the password in GET /config and keeps it when the masked config is saved back', async () => {
		await configStore.save(config);
		const response = await get('/config');
		assert.doesNotMatch(response.body, new RegExp(PASS));
		assert.equal((await sendJson('PUT', '/config', response.json())).statusCode, 200);
		assert.equal((await configStore.load()).proxyPool[0].password, PASS);
	});
});

describe('Supervisor with a pool proxy', () => {
	it('gives the crawler the proxy URL of the pool entry', async () => {
		await configStore.save(adminConfigSchema.parse({
			proxyPool: [{ host: '10.0.0.1', port: 80, username: 'u s', password: 'p@ss' }],
			crawlers: [{ name: 'a', type: 'item', proxy: { kind: 'pool', key: '10.0.0.1:80' } }],
		}));
		await supervisor.startCrawler('a');
		const child = launcher.of(CRAWLER_ENTRY).at(-1)!;
		assert.equal((child.sent[0] as { config: { proxy: string } }).config.proxy, 'http://u%20s:p%40ss@10.0.0.1:80');
		child.exit(0);
	});

	it('fails the start with a clear message that has no password when the key is missing', async () => {
		await configStore.save(adminConfigSchema.parse({
			proxyPool: [{ host: '10.0.0.1', port: 80, username: 'u', password: PASS }],
			crawlers: [{ name: 'b', type: 'item', proxy: { kind: 'pool', key: '10.0.0.9:80' } }],
		}));
		const before = launcher.of(CRAWLER_ENTRY).length;
		await assert.rejects(supervisor.startCrawler('b'), (error: Error) => {
			assert.match(error.message, /10\.0\.0\.9:80 of crawler b is not in the proxy pool/);
			assert.doesNotMatch(error.message, new RegExp(PASS));
			return true;
		});
		assert.equal(launcher.of(CRAWLER_ENTRY).length, before);
		const status = (await supervisor.status()).crawlers.find(item => item.name === 'b');
		assert.equal(status?.state, 'failed');
		assert.match(status?.error ?? '', /not in the proxy pool/);
	});
});

describe('proxy import API', () => {
	it('needs the security hooks', async () => {
		const anonymous = await app.inject({ method: 'POST', url: '/proxies/import', headers: { host: headers.host, origin }, payload: { text: LIST } });
		assert.equal(anonymous.statusCode, 401);
		const foreign = await app.inject({ method: 'POST', url: '/proxies/import', headers: { ...headers, origin: 'http://evil.com' }, payload: { text: LIST } });
		assert.equal(foreign.statusCode, 403);
	});

	it('imports the Webshare file and never returns a password', async () => {
		const response = await importList(`${LIST}bad line\r\n10.0.0.3:0:u:${PASS}\r\n10.0.0.1:6014:other:${PASS}\r\n`);
		assert.equal(response.statusCode, 200);
		assert.deepEqual(response.json(), {
			added: 2,
			updated: 0,
			skipped: 3,
			errors: [
				{ line: 3, message: 'expected host:port:username:password or http://username:password@host:port' },
				{ line: 4, message: 'the port must be a number from 1 to 65535' },
			],
			duplicateLines: [5],
		});
		assert.doesNotMatch(response.body, new RegExp(PASS));
		assert.deepEqual(saved().proxyPool.map((entry: { host: string; password: string }) => [entry.host, entry.password]), [
			['10.0.0.1', PASS],
			['10.0.0.2', PASS],
		]);
		const list = await get('/proxies');
		assert.deepEqual(list.json().map((item: { key: string }) => item.key), ['10.0.0.1:6014', '10.0.0.2:6641']);
		assert.doesNotMatch(list.body, new RegExp(PASS));
		assert.doesNotMatch((await get('/config')).body, new RegExp(PASS));
	});

	it('appends, and an existing key gets the new user name and password', async () => {
		await importList(LIST);
		const response = await importList(`10.0.0.2:6641:newuser:${PASS2}\n10.0.0.3:80:u:p`);
		assert.equal(response.json().added, 1);
		assert.equal(response.json().updated, 1);
		const pool = saved().proxyPool;
		assert.deepEqual(pool.map((entry: { host: string }) => entry.host), ['10.0.0.1', '10.0.0.2', '10.0.0.3']);
		assert.equal(pool[1].username, 'newuser');
		assert.equal(pool[1].password, PASS2);
	});

	it('replaces the pool', async () => {
		await importList(LIST);
		const response = await importList('10.0.0.9:80:u:p', 'replace');
		assert.equal(response.statusCode, 200);
		assert.equal(response.json().added, 1);
		assert.deepEqual(saved().proxyPool.map((entry: { host: string }) => entry.host), ['10.0.0.9']);
	});

	it('refuses replace with no valid proxy', async () => {
		await importList(LIST);
		const response = await importList('nothing useful', 'replace');
		assert.equal(response.statusCode, 409);
		assert.equal(saved().proxyPool.length, 2);
	});

	it('refuses a bad body and a bad mode', async () => {
		assert.equal((await sendJson('POST', '/proxies/import', {})).statusCode, 400);
		assert.equal((await importList(LIST, 'merge')).statusCode, 400);
	});

	it('refuses to delete or replace away a proxy that a crawler uses, and names the crawlers', async () => {
		await importList(LIST);
		await addPoolCrawler('c1', '10.0.0.1:6014');
		await addPoolCrawler('c2', '10.0.0.1:6014');

		const del409 = await sendJson('DELETE', `/proxies/${encodeURIComponent('10.0.0.1:6014')}`);
		assert.equal(del409.statusCode, 409);
		assert.match(del409.json().message, /10\.0\.0\.1:6014 is used by c1, c2/);

		const replace = await importList(`10.0.0.2:6641:u:${PASS}`, 'replace');
		assert.equal(replace.statusCode, 409);
		assert.match(replace.json().message, /10\.0\.0\.1:6014 \(used by c1, c2\)/);
		assert.doesNotMatch(replace.body, new RegExp(PASS));
		assert.equal(saved().proxyPool.length, 2);

		// replace may keep a used entry, and an unused one can be deleted
		const keep = await importList(`10.0.0.1:6014:u:${PASS2}`, 'replace');
		assert.equal(keep.statusCode, 200);
		assert.equal(keep.json().updated, 1);
		assert.equal(saved().proxyPool.length, 1);
		await importList(LIST);
		const removed = await sendJson('DELETE', `/proxies/${encodeURIComponent('10.0.0.2:6641')}`);
		assert.equal(removed.statusCode, 200);
		assert.deepEqual(removed.json().map((item: { key: string }) => item.key), ['10.0.0.1:6014']);
		assert.equal((await sendJson('DELETE', '/proxies/9.9.9.9%3A1')).statusCode, 404);
	});
});

describe('proxy fragments', () => {
	it('shows the import form with a file input and a mode select', async () => {
		const body = (await get('/fragments/proxy-import')).body;
		assert.match(body, /type="file"[^>]*accept="\.txt/);
		assert.match(body, /<textarea name="text"/);
		assert.match(body, /value="append" selected/);
		assert.match(body, /value="replace"/);
		assert.match(body, /Import/);
		assert.match((await get('/')).body, /id="proxy-import"/);
	});

	it('imports from the form, shows "N added, M updated, K skipped" and the bad lines, and hides passwords', async () => {
		await postForm('/fragments/proxy-import', { mode: 'append', text: `10.0.0.1:80:u:${PASS}` });
		const response = await postForm('/fragments/proxy-import', {
			mode: 'append',
			text: `10.0.0.1:80:u:${PASS2}\r\n10.0.0.2:80:u:${PASS}\r\nbroken\r\n10.0.0.3:99999:u:${PASS}`,
		});
		assert.equal(response.statusCode, 200);
		assert.match(response.body, /1 added, 1 updated, 2 skipped/);
		assert.match(response.body, /line 3: expected/);
		assert.match(response.body, /line 4: the port/);
		assert.match(response.body, /id="proxy-list" hx-swap-oob/);
		assert.match(response.body, /10\.0\.0\.2:80/);
		assert.doesNotMatch(response.body, new RegExp(`${PASS}|${PASS2}`));
		assert.doesNotMatch((await get('/fragments/proxy-list')).body, new RegExp(`${PASS}|${PASS2}`));
		assert.equal(saved().proxyPool[0].password, PASS2);
	});

	it('asks for a list when the text is empty', async () => {
		const response = await postForm('/fragments/proxy-import', { mode: 'append', text: '  ' });
		assert.match(response.body, /Choose a file or paste a list/);
	});

	it('shows a refused replace as a message, without the pasted text', async () => {
		await importList(`10.0.0.1:80:u:${PASS}\n10.0.0.2:80:u:${PASS}`);
		await addPoolCrawler('c1', '10.0.0.1:80');
		const response = await postForm('/fragments/proxy-import', { mode: 'replace', text: `10.0.0.2:80:u:${PASS2}` });
		assert.equal(response.statusCode, 200);
		assert.match(response.body, /class="error banner"/);
		assert.match(response.body, /10\.0\.0\.1:80 \(used by c1\)/);
		assert.doesNotMatch(response.body, new RegExp(`${PASS}|${PASS2}`));
		assert.equal(saved().proxyPool.length, 2);
	});

	it('lists the pool with the crawlers that use each entry', async () => {
		await importList(`10.0.0.1:80:u:${PASS}\n10.0.0.2:80:u:${PASS}`);
		await addPoolCrawler('c1', '10.0.0.1:80');
		const body = (await get('/fragments/proxy-list')).body;
		assert.match(body, /10\.0\.0\.1:80/);
		assert.match(body, /c1/);
		assert.match(body, /not used/);
		assert.match(body, /hx-delete="\/fragments\/proxy-list\/10\.0\.0\.1%3A80"/);
	});

	it('refuses to delete a used entry with a message that names the crawlers, and deletes an unused one', async () => {
		await importList(`10.0.0.1:80:u:${PASS}\n10.0.0.2:80:u:${PASS}`);
		await addPoolCrawler('c1', '10.0.0.1:80');
		const refused = await del('/fragments/proxy-list/10.0.0.1%3A80');
		assert.equal(refused.statusCode, 200);
		assert.match(refused.body, /toast-error/);
		assert.match(refused.body, /used by c1/);
		assert.equal(saved().proxyPool.length, 2);

		const done = await del('/fragments/proxy-list/10.0.0.2%3A80');
		assert.doesNotMatch(done.body, /toast-error/);
		assert.deepEqual(saved().proxyPool.map((entry: { host: string }) => entry.host), ['10.0.0.1']);
	});
});

describe('crawler form with a pool', () => {
	it('shows a select of pool entries and says when another crawler uses one', async () => {
		await importList(`10.0.0.1:80:u:${PASS}\n10.0.0.2:80:u:${PASS}`);
		await addPoolCrawler('c1', '10.0.0.1:80');
		const body = (await get('/fragments/crawler-form')).body;
		assert.match(body, /<option value="pool"/);
		assert.match(body, /<select name="poolKey">/);
		assert.match(body, /<option value="10\.0\.0\.2:80">10\.0\.0\.2:80<\/option>/);
		assert.match(body, /<option value="10\.0\.0\.1:80">10\.0\.0\.1:80 \(used by c1\)<\/option>/);
		assert.doesNotMatch(body, new RegExp(PASS));
	});

	it('saves a crawler with a pool proxy and selects it when it is edited, without a warning for itself', async () => {
		await importList(`10.0.0.1:80:u:${PASS}`);
		const response = await addPoolCrawler('c1', '10.0.0.1:80');
		assert.match(response.body, /hx-swap-oob/);
		assert.match(response.body, /pool 10\.0\.0\.1:80/);
		assert.deepEqual(saved().crawlers[0].proxy, { kind: 'pool', key: '10.0.0.1:80' });
		// saving a crawler keeps the pool and its passwords
		assert.equal(saved().proxyPool[0].password, PASS);

		const form = (await get('/fragments/crawler-form?name=c1')).body;
		assert.match(form, /<option value="10\.0\.0\.1:80" selected>10\.0\.0\.1:80<\/option>/);
		assert.doesNotMatch(form, /class="warn"/);
	});

	it('warns, but does not block, when two crawlers use the same entry', async () => {
		await importList(`10.0.0.1:80:u:${PASS}`);
		await addPoolCrawler('c1', '10.0.0.1:80');
		const second = await addPoolCrawler('c2', '10.0.0.1:80');
		assert.match(second.body, /hx-swap-oob/);
		assert.match(second.body, /Proxy 10\.0\.0\.1:80 is also used by c1\. Use one crawler per IP\./);
		assert.equal(saved().crawlers.length, 2);
		assert.match((await get('/fragments/proxy-list')).body, /Use one crawler per IP/);
		assert.match((await get('/fragments/crawler-form?name=c2')).body, /also used by c1/);
	});

	it('refuses a crawler with no choice or an unknown key', async () => {
		await importList(`10.0.0.1:80:u:${PASS}`);
		assert.match((await addPoolCrawler('c1', '')).body, /class="error"/);
		assert.match((await addPoolCrawler('c1', '10.0.0.9:80')).body, /not in the proxy pool/);
		assert.equal(saved().crawlers.length, 0);
	});

	it('keeps the Webshare key and the pool when a crawler is saved', async () => {
		await configStore.save(adminConfigSchema.parse({
			webshare: { apiKey: 'ws-key-value' },
			proxyPool: [{ host: '10.0.0.1', port: 80, username: 'u', password: PASS }],
		}));
		await addPoolCrawler('c1', '10.0.0.1:80');
		assert.equal(saved().webshare.apiKey, 'ws-key-value');
		assert.equal(saved().proxyPool[0].password, PASS);
	});

	it('refreshes the pool list when a crawler is removed, so the entry is free again', async () => {
		await importList(`10.0.0.1:80:u:${PASS}`);
		await addPoolCrawler('c1', '10.0.0.1:80');
		const removed = await del('/fragments/crawlers/c1');
		assert.match(removed.body, /id="proxy-list" hx-swap-oob/);
		assert.match(removed.body, /not used/);
		assert.doesNotMatch(removed.body, new RegExp(PASS));
	});
});
