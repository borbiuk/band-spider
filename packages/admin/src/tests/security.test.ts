import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { buildApp } from '../app';
import { JsonFileConfigStore } from '../config-store';
import { SECRET_MASK } from '../secrets';
import { isAllowedHost, isAllowedOrigin } from '../security';
import { startAdmin } from '../service';
import { Supervisor } from '../supervisor';
import { CRAWLER_ENTRY, DB_ENTRY, readyDbLauncher } from './fakes';

const TOKEN = 'secret-token';
const PORT = 4200;
const HOST = `127.0.0.1:${PORT}`;

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'band-spider-admin-security-'));
const configStore = new JsonFileConfigStore(path.join(tempDir, 'config.json'));
const newSupervisor = () => new Supervisor({
	launcher: readyDbLauncher(),
	configStore,
	entries: { dbService: DB_ENTRY, crawler: CRAWLER_ENTRY },
	stopTimeoutMs: 50,
});

let app: ReturnType<typeof buildApp>;

before(() => {
	app = buildApp({ supervisor: newSupervisor(), configStore, security: { token: TOKEN, port: () => PORT } });
});

after(async () => {
	await app.close();
	fs.rmSync(tempDir, { recursive: true, force: true });
});

const send = (method: 'GET' | 'POST' | 'PUT', url: string, headers: Record<string, string>, payload?: object) =>
	app.inject({ method, url, headers: { host: HOST, ...headers }, payload });

const auth = { authorization: `Bearer ${TOKEN}` };

describe('admin security: Host', () => {
	it('accepts local names with the right port only', () => {
		assert.ok(isAllowedHost('127.0.0.1:4200', 4200));
		assert.ok(isAllowedHost('localhost:4200', 4200));
		assert.ok(isAllowedHost('LOCALHOST:4200', 4200));
		assert.ok(isAllowedHost('[::1]:4200', 4200));
		assert.ok(isAllowedHost('localhost', 80));
		assert.ok(!isAllowedHost('localhost:4201', 4200));
		assert.ok(!isAllowedHost('evil.com:4200', 4200));
		assert.ok(!isAllowedHost('127.0.0.1.evil.com:4200', 4200));
		assert.ok(!isAllowedHost('localhost:4200@evil.com', 4200));
		assert.ok(!isAllowedHost(undefined, 4200));
	});

	it('refuses a wrong Host even with a good token', async () => {
		for (const host of ['evil.com', 'evil.com:4200', 'localhost:9999', '127.0.0.1.evil.com:4200']) {
			const response = await send('GET', '/status', { ...auth, host });
			assert.equal(response.statusCode, 403, host);
			assert.equal(typeof response.json().message, 'string');
		}
	});

	it('refuses a wrong Host on /health too', async () => {
		assert.equal((await send('GET', '/health', { host: 'evil.com' })).statusCode, 403);
	});
});

describe('admin security: Origin', () => {
	it('accepts only the own origin', () => {
		assert.ok(isAllowedOrigin('http://127.0.0.1:4200', 4200));
		assert.ok(isAllowedOrigin('http://localhost:4200', 4200));
		assert.ok(!isAllowedOrigin('http://evil.com', 4200));
		assert.ok(!isAllowedOrigin('http://localhost:4201', 4200));
		assert.ok(!isAllowedOrigin('https://localhost:4200', 4200));
		assert.ok(!isAllowedOrigin('null', 4200));
	});

	it('refuses a state-changing request from another origin', async () => {
		for (const origin of ['http://evil.com', 'null', 'http://localhost:9999']) {
			const response = await send('POST', '/stop-all', { ...auth, origin });
			assert.equal(response.statusCode, 403, origin);
		}
		assert.equal((await send('PUT', '/config', { ...auth, origin: 'http://evil.com' }, {})).statusCode, 403);
	});

	it('allows the own origin and a request without Origin', async () => {
		assert.equal((await send('POST', '/stop-all', { ...auth, origin: `http://${HOST}` })).statusCode, 200);
		assert.equal((await send('POST', '/stop-all', auth)).statusCode, 200);
	});

	it('does not check Origin on a read request', async () => {
		assert.equal((await send('GET', '/status', { ...auth, origin: 'http://evil.com' })).statusCode, 200);
	});
});

describe('admin security: token', () => {
	it('refuses a missing or wrong token with 401', async () => {
		assert.equal((await send('GET', '/status', {})).statusCode, 401);
		assert.equal((await send('POST', '/stop-all', {})).statusCode, 401);
		assert.equal((await send('GET', '/status', { authorization: 'Bearer nope' })).statusCode, 401);
		assert.equal((await send('GET', '/status', { cookie: 'admin_token=nope' })).statusCode, 401);
		assert.equal((await send('GET', '/config', {})).statusCode, 401);
	});

	it('does not accept the token in the query string', async () => {
		assert.equal((await send('GET', `/status?token=${TOKEN}`, {})).statusCode, 401);
	});

	it('leaves /health open', async () => {
		assert.equal((await send('GET', '/health', {})).statusCode, 200);
	});

	it('accepts the token in a header or a cookie', async () => {
		assert.equal((await send('GET', '/status', auth)).statusCode, 200);
		assert.equal((await send('GET', '/status', { 'x-admin-token': TOKEN })).statusCode, 200);
		assert.equal((await send('GET', '/status', { cookie: `other=1; admin_token=${TOKEN}` })).statusCode, 200);
	});

	it('turns the token of the session URL into a cookie', async () => {
		const bad = await send('GET', '/session?token=nope', {});
		assert.equal(bad.statusCode, 401);
		assert.equal(bad.headers['set-cookie'], undefined);

		const good = await send('GET', `/session?token=${TOKEN}`, {});
		assert.equal(good.statusCode, 302);
		const cookie = String(good.headers['set-cookie']);
		assert.ok(cookie.includes(`admin_token=${TOKEN}`));
		assert.ok(cookie.includes('HttpOnly'));
		assert.ok(cookie.includes('SameSite=Strict'));
	});

	it('refuses the session URL for a wrong Host', async () => {
		assert.equal((await send('GET', `/session?token=${TOKEN}`, { host: 'evil.com' })).statusCode, 403);
	});
});

describe('admin security: secrets', () => {
	const config = {
		dbService: { port: 4100, token: 'db-secret-token' },
		crawlers: [
			{ name: 'ws', type: 'item', proxy: { kind: 'webshare', entry: { host: 'p.example.com', port: 80, username: 'u', password: 'ws-secret-pass' } } },
			{ name: 'url', type: 'account', proxy: { kind: 'url', url: 'http://user:url-secret-pass@proxy.example.com:8080' } },
		],
	};

	it('never returns a secret, and keeps the saved one when the masked config is saved back', async () => {
		const saved = await send('PUT', '/config', auth, config);
		assert.equal(saved.statusCode, 200);
		for (const text of [saved.body, (await send('GET', '/config', auth)).body]) {
			assert.ok(!text.includes('db-secret-token'));
			assert.ok(!text.includes('ws-secret-pass'));
			assert.ok(!text.includes('url-secret-pass'));
			assert.ok(text.includes(SECRET_MASK));
		}
		// the file has the real values
		assert.equal((await configStore.load()).dbService.token, 'db-secret-token');

		// the browser sends the masked config back
		const masked = (await send('GET', '/config', auth)).json();
		masked.crawlers[0].workers = 3;
		assert.equal((await send('PUT', '/config', auth, masked)).statusCode, 200);
		const stored = await configStore.load();
		assert.equal(stored.crawlers[0].workers, 3);
		assert.equal(stored.dbService.token, 'db-secret-token');
		const [ws, url] = stored.crawlers.map(crawler => crawler.proxy);
		assert.equal(ws.kind === 'webshare' && ws.entry.password, 'ws-secret-pass');
		assert.equal(url.kind === 'url' && new URL(url.url).password, 'url-secret-pass');
	});

	it('refuses a masked secret that has no saved value', async () => {
		const response = await send('PUT', '/config', auth, {
			crawlers: [{ name: 'new', type: 'item', proxy: { kind: 'webshare', entry: { host: 'h', port: 1, username: 'u', password: SECRET_MASK } } }],
		});
		assert.equal(response.statusCode, 400);
		assert.equal((await configStore.load()).crawlers.length, 2);
	});

	it('replaces a secret when a new one is sent', async () => {
		const masked = (await send('GET', '/config', auth)).json();
		masked.dbService.token = 'new-db-token';
		await send('PUT', '/config', auth, masked);
		assert.equal((await configStore.load()).dbService.token, 'new-db-token');
	});
});

describe('admin security: real server', () => {
	it('listens on a random port, checks the real port and prints a session URL', async () => {
		const admin = await startAdmin({
			host: '127.0.0.1',
			port: 0,
			configStore,
			launcher: readyDbLauncher(),
			entries: { dbService: DB_ENTRY, crawler: CRAWLER_ENTRY },
		});
		try {
			assert.match(admin.token, /^[0-9a-f]{64}$/);
			assert.equal(admin.sessionUrl, `${admin.url}/session?token=${admin.token}`);

			assert.equal((await fetch(`${admin.url}/health`)).status, 200);
			assert.equal((await fetch(`${admin.url}/status`)).status, 401);
			const ok = await fetch(`${admin.url}/status`, { headers: { authorization: `Bearer ${admin.token}` } });
			assert.equal(ok.status, 200);

			const session = await fetch(admin.sessionUrl, { redirect: 'manual' });
			assert.equal(session.status, 302);
			assert.ok(String(session.headers.get('set-cookie')).includes(admin.token));
		} finally {
			await admin.stop();
		}
	});

	it('makes a new token for every start', async () => {
		const start = () => startAdmin({
			host: '127.0.0.1',
			port: 0,
			configStore,
			launcher: readyDbLauncher(),
			entries: { dbService: DB_ENTRY, crawler: CRAWLER_ENTRY },
		});
		const [first, second] = [await start(), await start()];
		try {
			assert.notEqual(first.token, second.token);
		} finally {
			await first.stop();
			await second.stop();
		}
	});
});
