import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { buildApp } from '../app';
import { JsonFileConfigStore } from '../config-store';
import { SECRET_MASK } from '../secrets';
import { SESSION_COOKIE } from '../security';
import { Supervisor } from '../supervisor';
import { CRAWLER_ENTRY, DB_ENTRY, FakeLauncher, readyDbLauncher } from './fakes';

const TOKEN = 'test-token';
const PORT = 4200;

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'band-spider-admin-ui-'));
const configFile = path.join(tempDir, 'config.json');

let launcher: FakeLauncher;
let app: ReturnType<typeof buildApp>;
let supervisor: Supervisor;

before(() => {
	launcher = readyDbLauncher();
	const configStore = new JsonFileConfigStore(configFile);
	supervisor = new Supervisor({
		launcher,
		configStore,
		entries: { dbService: DB_ENTRY, crawler: CRAWLER_ENTRY },
		stopTimeoutMs: 50,
		dbStatsIntervalMs: 0,
	});
	app = buildApp({ supervisor, configStore, security: { token: TOKEN, port: () => PORT } });
});

after(async () => {
	await app.close();
	fs.rmSync(tempDir, { recursive: true, force: true });
});

const headers = { host: `127.0.0.1:${PORT}`, cookie: `${SESSION_COOKIE}=${TOKEN}` };

const get = (url: string) => app.inject({ method: 'GET', url, headers });
const post = (url: string, form?: Record<string, string>) =>
	app.inject({
		method: 'POST',
		url,
		headers: { ...headers, origin: `http://127.0.0.1:${PORT}`, 'content-type': 'application/x-www-form-urlencoded' },
		payload: new URLSearchParams(form).toString(),
	});
const del = (url: string) => app.inject({ method: 'DELETE', url, headers: { ...headers, origin: `http://127.0.0.1:${PORT}` } });

const savedConfig = () => JSON.parse(fs.readFileSync(configFile, 'utf8'));

describe('admin page', () => {
	it('needs the session cookie, then serves the page and its files without a CDN', async () => {
		const anonymous = await app.inject({ method: 'GET', url: '/', headers: { host: headers.host } });
		assert.equal(anonymous.statusCode, 401);

		const page = await get('/');
		assert.equal(page.statusCode, 200);
		assert.match(page.headers['content-type'] as string, /text\/html/);
		assert.match(page.headers['content-security-policy'] as string, /script-src 'self'/);
		assert.match(page.body, /\/assets\/htmx\.min\.js/);
		assert.doesNotMatch(page.body, /https?:\/\//);

		const htmx = await get('/assets/htmx.min.js');
		assert.equal(htmx.statusCode, 200);
		assert.match(htmx.body, /htmx/);
		assert.equal((await get('/assets/app.js')).statusCode, 200);
		assert.equal((await get('/assets/app.css')).statusCode, 200);
		assert.equal((await app.inject({ method: 'GET', url: '/assets/app.js', headers: { host: headers.host } })).statusCode, 401);
	});

	it('shows the DB service and the empty crawler list', async () => {
		const response = await get('/fragments/status');
		assert.equal(response.statusCode, 200);
		assert.match(response.body, /DB service/);
		assert.match(response.body, /state-stopped/);
		assert.match(response.body, /No crawlers yet/);
	});

	it('shows the add form', async () => {
		const response = await get('/fragments/crawler-form');
		assert.match(response.body, /Add crawler/);
		assert.match(response.body, /name="proxyKind"/);
	});

	it('adds a crawler from the form and updates the status in the same response', async () => {
		const response = await post('/fragments/crawlers', {
			original: '', name: 'items', type: 'item', workers: '3', minDelayMs: '', maxDelayMs: '', proxyKind: 'none',
		});
		assert.equal(response.statusCode, 200);
		assert.match(response.body, /hx-swap-oob/);
		assert.match(response.body, /items/);
		assert.deepEqual(savedConfig().crawlers, [{ name: 'items', type: 'item', reverse: false, workers: 3, proxy: { kind: 'none' } }]);
	});

	it('shows a bad form again with the message and saves nothing', async () => {
		const bad = await post('/fragments/crawlers', { original: '', name: 'a b', type: 'item', workers: '1', proxyKind: 'none' });
		assert.match(bad.body, /class="error"/);
		assert.match(bad.body, /<form/);

		const duplicate = await post('/fragments/crawlers', { original: '', name: 'ITEMS', type: 'item', workers: '1', proxyKind: 'none' });
		assert.match(duplicate.body, /unique/);

		const badProxy = await post('/fragments/crawlers', { original: '', name: 'x', type: 'item', workers: '1', proxyKind: 'url', proxyUrl: 'nope' });
		assert.match(badProxy.body, /class="error"/);
		assert.equal(savedConfig().crawlers.length, 1);
	});

	it('keeps a saved Webshare password when the masked form is saved', async () => {
		await post('/fragments/crawlers', {
			original: '', name: 'ws', type: 'account', reverse: 'on', workers: '2', proxyKind: 'webshare',
			wsHost: 'proxy.example.com', wsPort: '8080', wsUser: 'user', wsPassword: 'secret-pass',
		});
		assert.equal(savedConfig().crawlers[1].proxy.entry.password, 'secret-pass');

		const form = await get('/fragments/crawler-form?name=ws');
		assert.match(form.body, new RegExp(`value="${SECRET_MASK.replace(/\*/g, '\\*')}"`));
		assert.doesNotMatch(form.body, /secret-pass/);

		const saved = await post('/fragments/crawlers', {
			original: 'ws', name: 'ignored', type: 'account', reverse: 'on', workers: '5', proxyKind: 'webshare',
			wsHost: 'proxy.example.com', wsPort: '8080', wsUser: 'user', wsPassword: SECRET_MASK,
		});
		assert.match(saved.body, /hx-swap-oob/);
		const crawler = savedConfig().crawlers[1];
		assert.equal(crawler.name, 'ws');
		assert.equal(crawler.workers, 5);
		assert.equal(crawler.proxy.entry.password, 'secret-pass');
		// the status never has the password
		assert.doesNotMatch((await get('/fragments/status')).body, /secret-pass/);
	});

	it('starts a crawler, shows its state and counts, and refuses to remove it while it runs', async () => {
		const started = await post('/fragments/crawlers/items/start');
		assert.equal(started.statusCode, 200);
		assert.match(started.body, /state-starting/);

		const child = launcher.of(CRAWLER_ENTRY)[0];
		child.emit({ type: 'started' });
		child.emit({ type: 'progress', counts: { claimed: 7, saved: 5, failed: 1, rateLimited: 0, notFound: 0 } });
		const running = (await get('/fragments/status')).body;
		assert.match(running, /state-running/);
		assert.match(running, /7 claimed, 5 saved/);

		const removed = await del('/fragments/crawlers/items');
		assert.equal(removed.statusCode, 200);
		assert.match(removed.body, /Stop crawler items first/);
		assert.equal(savedConfig().crawlers.length, 2);
	});

	it('shows a control error on the page and not as an HTTP error', async () => {
		const response = await post('/fragments/crawlers/items/start');
		assert.equal(response.statusCode, 200);
		assert.match(response.body, /Already/);
		const unknown = await post('/fragments/crawlers/nope/start');
		assert.match(unknown.body, /No crawler nope/);
		assert.equal((await post('/fragments/crawlers/items/explode')).statusCode, 404);
	});

	it('shows logs as escaped text without colors', async () => {
		launcher.of(CRAWLER_ENTRY)[0].print('\u001b[32mgreen\u001b[39m <script>alert(1)</script>\n');
		const response = await get('/fragments/logs?source=crawler%3Aitems');
		assert.match(response.body, /green &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
		assert.doesNotMatch(response.body, /<script>/);
		assert.doesNotMatch(response.body, /\u001b/);

		// no output yet is not an error
		const none = await get('/fragments/logs?source=crawler%3Aws');
		assert.equal(none.statusCode, 200);
		assert.match((await get('/fragments/logs?source=db')).body, /Logs: db/);
	});

	it('stops everything and then removes a crawler', async () => {
		const stopped = await post('/fragments/all/stop');
		assert.equal(stopped.statusCode, 200);
		assert.doesNotMatch(stopped.body, /state-running/);

		const removed = await del('/fragments/crawlers/items');
		assert.doesNotMatch(removed.body, /Stop crawler/);
		assert.deepEqual(savedConfig().crawlers.map((crawler: { name: string }) => crawler.name), ['ws']);
	});
});

describe('events (SSE)', () => {
	it('needs the token', async () => {
		const response = await app.inject({ method: 'GET', url: '/events', headers: { host: headers.host } });
		assert.equal(response.statusCode, 401);
	});

	it('sends status changes and log text over one stream', async () => {
		// the shared app checks the Host against a fixed port, so this one learns the real port after listen
		let port = 0;
		const sseApp = buildApp({
			supervisor,
			configStore: new JsonFileConfigStore(configFile),
			security: { token: TOKEN, port: () => port },
		});
		await sseApp.listen({ host: '127.0.0.1', port: 0 });
		port = (sseApp.server.address() as { port: number }).port;

		let received = '';
		const request = http.get(
			{ host: '127.0.0.1', port, path: '/events', headers: { authorization: `Bearer ${TOKEN}` } },
			response => {
				assert.equal(response.statusCode, 200);
				assert.match(response.headers['content-type'] as string, /text\/event-stream/);
				response.setEncoding('utf8');
				response.on('data', chunk => received += chunk);
			},
		);
		const waitFor = async (pattern: RegExp): Promise<void> => {
			for (let i = 0; i < 100 && !pattern.test(received); i++) {
				await new Promise(resolve => setTimeout(resolve, 20));
			}
			assert.match(received, pattern);
		};

		await waitFor(/: connected/);
		// a state change gives a status event
		await supervisor.startDb();
		await waitFor(/event: status\ndata: \{\}/);
		// output of the child gives a log event, without colors
		launcher.of(DB_ENTRY).at(-1)!.print('\u001b[31mhello db\u001b[39m\n');
		await waitFor(/event: log\ndata: \{"source":"db","text":"hello db\\n"\}/);

		// a closed client is forgotten, and the server can close with an open stream
		request.destroy();
		await supervisor.stopDb();
		await sseApp.close();
	});
});
