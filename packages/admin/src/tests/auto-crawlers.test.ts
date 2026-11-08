import assert from 'node:assert/strict';
import { CrawlerStats } from '../crawler-metrics';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';
import { DEFAULT_IDLE_MS, MAX_REQUEST_DELAY_MS, MIN_REQUEST_DELAY_MS } from '@band-spider/core';
import { buildApp } from '../app';
import { freePoolKeys, planAutoCrawlers } from '../auto-crawlers';
import { AdminConfig, adminConfigSchema, CrawlerSetting } from '../config';
import { JsonFileConfigStore } from '../config-store';
import { SESSION_COOKIE } from '../security';
import { Supervisor } from '../supervisor';
import { CRAWLER_ENTRY, DB_ENTRY, readyDbLauncher } from './fakes';
import { emptyForm, formFromSetting, hasCustomSettings, bytesText, renderCrawlerForm, renderStatus, settingsText } from '../ui-render';

const TOKEN = 'test-token';
const PORT = 4202;
const PASS = 'zz-secret-pass-3';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'band-spider-admin-auto-'));
const configFile = path.join(tempDir, 'config.json');
const configStore = new JsonFileConfigStore(configFile);
const supervisor = new Supervisor({
	launcher: readyDbLauncher(),
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
const sendJson = (url: string, payload?: unknown) =>
	app.inject({ method: 'POST', url, headers: { ...headers, origin }, payload: payload as object });
const postForm = (url: string, form: Record<string, string>) =>
	app.inject({
		method: 'POST',
		url,
		headers: { ...headers, origin, 'content-type': 'application/x-www-form-urlencoded' },
		payload: new URLSearchParams(form).toString(),
	});
const saved = () => JSON.parse(fs.readFileSync(configFile, 'utf8'));

const proxies = (count: number) =>
	Array.from({ length: count }, (_, i) => ({ host: `10.0.0.${i + 1}`, port: 80, username: 'u', password: PASS }));

const configOf = (poolSize: number, crawlers: unknown[] = []): AdminConfig =>
	adminConfigSchema.parse({ proxyPool: proxies(poolSize), crawlers });

const pooled = (name: string, key: string) => ({ name, type: 'item', proxy: { kind: 'pool', key } });

beforeEach(async () => {
	await configStore.save(adminConfigSchema.parse({}));
});

describe('free proxies', () => {
	it('finds the proxies that no crawler uses', () => {
		const config = configOf(3, [pooled('a', '10.0.0.2:80'), { name: 'b', type: 'item', proxy: { kind: 'none' } }]);
		assert.deepEqual(freePoolKeys(config), ['10.0.0.1:80', '10.0.0.3:80']);
		assert.deepEqual(freePoolKeys(configOf(0)), []);
	});

	it('names crawlers without a clash with the existing ones', () => {
		const config = configOf(3, [
			{ name: 'items-1', type: 'item' },
			{ name: 'Items-3', type: 'item' },
			{ name: 'accounts-1', type: 'account' },
		]);
		const planned = planAutoCrawlers(config, 'item');
		assert.deepEqual(planned.map(crawler => crawler.name), ['items-2', 'items-4', 'items-5']);
		assert.deepEqual(planAutoCrawlers(configOf(1, [{ name: 'accounts-1', type: 'account' }]), 'account').map(c => c.name), ['accounts-2']);
	});

	it('sets only the name, the type and the pool proxy', () => {
		const [crawler] = planAutoCrawlers(configOf(1), 'account');
		assert.deepEqual(crawler, { name: 'accounts-1', type: 'account', reverse: false, workers: 1, proxy: { kind: 'pool', key: '10.0.0.1:80' } });
	});

	it('plans a crawler for a chosen proxy that is already used, and skips keys that are not in the pool', () => {
		const config = configOf(3, [pooled('a', '10.0.0.2:80'), pooled('b', '10.0.0.2:80')]);
		const planned = planAutoCrawlers(config, 'item', ['10.0.0.3:80', '10.0.0.2:80', 'nope:1']);
		assert.deepEqual(planned.map(crawler => [crawler.name, crawler.proxy]), [
			['items-1', { kind: 'pool', key: '10.0.0.2:80' }],
			['items-2', { kind: 'pool', key: '10.0.0.3:80' }],
		]);
		assert.deepEqual(planAutoCrawlers(config, 'item').map(crawler => crawler.proxy), [
			{ kind: 'pool', key: '10.0.0.1:80' },
			{ kind: 'pool', key: '10.0.0.3:80' },
		]);
	});

	it('alternates items and accounts in split mode, items first', () => {
		const planned = planAutoCrawlers(configOf(5), 'split');
		assert.deepEqual(planned.map(crawler => crawler.name), ['items-1', 'accounts-1', 'items-2', 'accounts-2', 'items-3']);
		assert.deepEqual(planned.map(crawler => crawler.type), ['item', 'account', 'item', 'account', 'item']);
	});
});

describe('add crawlers for free proxies (API)', () => {
	const seed = (poolSize: number, crawlers: unknown[] = []) => configStore.save(configOf(poolSize, crawlers));

	it('adds one crawler for each free proxy, keeps the rest of the config and writes no defaults', async () => {
		await configStore.save(adminConfigSchema.parse({
			webshare: { apiKey: 'key-1' },
			dbService: { port: 4555 },
			proxyPool: proxies(3),
			crawlers: [pooled('first', '10.0.0.1:80')],
		}));
		const response = await sendJson('/proxies/free-crawlers', { type: 'split' });
		assert.equal(response.statusCode, 200);
		assert.deepEqual(response.json(), { added: 2, names: ['items-1', 'accounts-1'] });

		const config = saved();
		assert.deepEqual(config.crawlers, [
			{ name: 'first', type: 'item', proxy: { kind: 'pool', key: '10.0.0.1:80' } },
			{ name: 'items-1', type: 'item', proxy: { kind: 'pool', key: '10.0.0.2:80' } },
			{ name: 'accounts-1', type: 'account', proxy: { kind: 'pool', key: '10.0.0.3:80' } },
		]);
		assert.equal(config.webshare.apiKey, 'key-1');
		assert.equal(config.dbService.port, 4555);
		assert.equal(config.proxyPool.length, 3);
		assert.equal(config.proxyPool[0].password, PASS);
		assert.equal(freePoolKeys(await configStore.load()).length, 0);
	});

	it('defaults to items and says so when there is no free proxy', async () => {
		await seed(1);
		assert.deepEqual((await sendJson('/proxies/free-crawlers', {})).json(), { added: 1, names: ['items-1'] });
		const again = await sendJson('/proxies/free-crawlers', {});
		assert.deepEqual(again.json(), { added: 0, names: [] });
		assert.equal(saved().crawlers.length, 1);
	});

	it('refuses an unknown type and needs the same security as the other routes', async () => {
		assert.equal((await sendJson('/proxies/free-crawlers', { type: 'nope' })).statusCode, 400);
		const foreign = await app.inject({ method: 'POST', url: '/proxies/free-crawlers', headers: { ...headers, origin: 'http://evil.example' }, payload: {} });
		assert.equal(foreign.statusCode, 403);
		const anonymous = await app.inject({ method: 'POST', url: '/proxies/free-crawlers', headers: { host: headers.host, origin }, payload: {} });
		assert.equal(anonymous.statusCode, 401);
	});

	it('does not start the new crawlers and never returns a password', async () => {
		await seed(2);
		const response = await sendJson('/proxies/free-crawlers', { type: 'item' });
		assert.doesNotMatch(response.body, new RegExp(PASS));
		assert.ok((await supervisor.status()).crawlers.every(crawler => crawler.state === 'stopped'));
	});
});

describe('add crawlers for free proxies (page)', () => {
	it('shows the button with the type choice only when the pool has proxies', async () => {
		const empty = await app.inject({ method: 'GET', url: '/fragments/proxy-list', headers });
		assert.doesNotMatch(empty.body, /Add crawlers for free proxies/);

		await configStore.save(configOf(2));
		const list = await app.inject({ method: 'GET', url: '/fragments/proxy-list', headers });
		assert.match(list.body, /Add crawlers for free proxies/);
		assert.match(list.body, /<option value="item" selected>item<\/option><option value="account">account<\/option><option value="split">split<\/option>/);
		assert.doesNotMatch(list.body, new RegExp(PASS));
	});

	it('adds the crawlers, shows the count and refreshes both the pool list and the crawler table', async () => {
		await configStore.save(configOf(3));
		const response = await postForm('/fragments/proxies/free-crawlers', { type: 'split' });
		assert.equal(response.statusCode, 200);
		assert.match(response.body, /3 crawlers added/);
		assert.match(response.body, /hx-swap-oob/);
		// the crawler table
		assert.match(response.body, /items-1/);
		assert.match(response.body, /accounts-1/);
		assert.match(response.body, /pool 10\.0\.0\.1:80/);
		// the pool list shows who uses each proxy
		assert.match(response.body, /<td>items-2<\/td>|items-2/);
		assert.doesNotMatch(response.body, /not used/);
		assert.doesNotMatch(response.body, new RegExp(PASS));
		assert.equal(saved().crawlers.length, 3);
	});

	it('says when there is no free proxy and changes nothing', async () => {
		await configStore.save(configOf(1, [pooled('a', '10.0.0.1:80')]));
		const response = await postForm('/fragments/proxies/free-crawlers', { type: 'item' });
		assert.match(response.body, /No free proxy/);
		assert.equal(saved().crawlers.length, 1);
	});
});

describe('create crawlers for chosen proxies (page)', () => {
	const postKeys = (keys: string[], extra: Record<string, string> = {}) =>
		app.inject({
			method: 'POST',
			url: '/fragments/proxies/chosen-crawlers',
			headers: { ...headers, origin, 'content-type': 'application/x-www-form-urlencoded' },
			payload: [...keys.map(key => ['keys', key]), ...Object.entries(extra)]
				.map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join('&'),
		});

	it('draws a checkbox for each proxy, marks the free ones and has select all and select free', async () => {
		await configStore.save(configOf(2, [pooled('a', '10.0.0.1:80')]));
		const list = await app.inject({ method: 'GET', url: '/fragments/proxy-list', headers });
		assert.match(list.body, /name="keys" value="10\.0\.0\.1:80" aria-label="Choose 10\.0\.0\.1:80">/);
		assert.match(list.body, /name="keys" value="10\.0\.0\.2:80"[^>]* data-free>/);
		assert.doesNotMatch(list.body, /name="keys"[^>]* disabled/);
		assert.match(list.body, /data-select="all"/);
		assert.match(list.body, /data-select="free"/);
		assert.match(list.body, /Create crawlers for chosen proxies/);
	});

	it('adds a crawler for each chosen proxy, also for a used one, with the chosen type', async () => {
		await configStore.save(configOf(4, [pooled('a', '10.0.0.1:80')]));
		const response = await postKeys(['10.0.0.1:80', '10.0.0.3:80', '10.0.0.4:80', 'nope:1'], { type: 'account' });
		assert.match(response.body, /3 crawlers added: accounts-1, accounts-2, accounts-3/);
		const crawlers = saved().crawlers;
		assert.deepEqual(crawlers.map((item: CrawlerSetting) => [item.name, item.type, item.proxy]), [
			['a', 'item', { kind: 'pool', key: '10.0.0.1:80' }],
			['accounts-1', 'account', { kind: 'pool', key: '10.0.0.1:80' }],
			['accounts-2', 'account', { kind: 'pool', key: '10.0.0.3:80' }],
			['accounts-3', 'account', { kind: 'pool', key: '10.0.0.4:80' }],
		]);
		assert.ok((await supervisor.status()).crawlers.every(item => item.state === 'stopped'));
	});

	it('starts the new crawlers when asked', async () => {
		await configStore.save(configOf(2));
		const response = await postKeys(['10.0.0.1:80', '10.0.0.2:80'], { type: 'item', start: '1' });
		assert.match(response.body, /2 crawlers started/);
		const states = (await supervisor.status()).crawlers.map(item => item.state);
		assert.equal(states.length, 2);
		assert.ok(states.every(state => state === 'starting' || state === 'running'));
		await supervisor.stopAll();
	});

	it('asks for a choice when nothing is chosen and changes nothing', async () => {
		await configStore.save(configOf(2));
		const response = await postKeys([], { type: 'item' });
		assert.match(response.body, /Choose at least one proxy first/);
		assert.equal(saved().crawlers.length, 0);
	});

	it('refuses a type that is not item or account', async () => {
		await configStore.save(configOf(2));
		const response = await postKeys(['10.0.0.1:80'], { type: 'split' });
		assert.match(response.body, /type/);
		assert.equal(saved().crawlers.length, 0);
	});
});

describe('filter and sort of the crawler table', () => {
	it('gives each row the values the page script reads', async () => {
		await configStore.save(configOf(1, [{ name: 'a', type: 'account', proxy: { kind: 'pool', key: '10.0.0.1:80' } }]));
		const page = await app.inject({ method: 'GET', url: '/fragments/status', headers });
		assert.match(page.body, /data-tools/);
		assert.match(page.body, /data-index="0" data-name="a" data-state="stopped" data-type="account" data-search="a pool 10\.0\.0\.1:80"/);
		assert.match(page.body, /<option value="requests">requests\/min<\/option>/);
	});

	it('has no controls when there is no crawler', async () => {
		const page = renderStatus({ ...(await supervisor.status()), crawlers: [] }, configOf(0));
		assert.doesNotMatch(page, /data-tools/);
	});
});

describe('traffic and new links in the crawler table', () => {
	it('formats sizes', () => {
		assert.equal(bytesText(0), '0 B');
		assert.equal(bytesText(999), '999 B');
		assert.equal(bytesText(12_400_000), '12.4 MB');
		assert.equal(bytesText(1_500_000_000), '1.5 GB');
		assert.equal(bytesText(250_000_000_000), '250 GB');
	});

	it('shows the traffic and the links of a crawler, and the month estimate on top', async () => {
		const config = configOf(1, [pooled('a', '10.0.0.1:80'), { name: 'local', type: 'item', proxy: { kind: 'none' } }]);
		const status = await supervisor.status();
		const stats = {
			requestsPerMin: 1, urlsPerMin: 1, http429PerHour: 0, bytesPerHour: 36_000_000, linksPerMin: 4.5, failedPerMin: 0,
			totals: { requests: 1, processed: 1, failed: 0, http429: 0, bytes: 1_500_000_000, newLinks: 321 }, pauseMs: 0, idle: false, failures: [] as CrawlerStats['failures'],
		};
		const page = renderStatus({
			...status,
			crawlers: [
				{ name: 'a', configured: true, state: 'running', stats },
				{ name: 'local', configured: true, state: 'running', stats: { ...stats, bytesPerHour: 0, totals: { ...stats.totals, bytes: 0 } } },
			],
		}, config);
		assert.match(page, /data-sort="links" title="Sort by new item-account links per minute">Links\/min/);
		assert.match(page, /data-sort="bytes" title="Sort by traffic through the proxy per hour">Traffic\/hour/);
		assert.match(page, /data-label="Traffic\/hour"><b>36\.0 MB<\/b><span class="sub">1\.5 GB total<\/span>/);
		assert.match(page, /data-label="Links\/min"><b>4\.5<\/b><span class="sub">321 total<\/span>/);
		assert.match(page, /local IP, not counted/);
		// one crawler is billed: 36 MB an hour for 720 hours
		assert.match(page, /~25\.9 GB\/month/);
		assert.match(page, /data-bytes="36000000" data-links="4\.5"/);
		assert.match(page, /<option value="bytes">traffic\/hour<\/option><option value="links">new links\/min<\/option>/);
	});
});

const crawler = (extra: Record<string, unknown> = {}): CrawlerSetting =>
	({ name: 'c', type: 'item', reverse: false, workers: 1, proxy: { kind: 'none' }, ...extra }) as CrawlerSetting;

describe('crawler settings text', () => {
	it('shows only the type for a crawler with the defaults', () => {
		assert.equal(settingsText(crawler()), 'item');
		assert.doesNotMatch(settingsText(crawler()), /workers/);
	});

	it('shows only what differs from the defaults', () => {
		assert.equal(settingsText(crawler({ workers: 3 })), 'item, 3 workers');
		assert.equal(settingsText(crawler({ type: 'account', reverse: true })), 'account, reverse');
		assert.equal(settingsText(crawler({ minDelayMs: 100, maxDelayMs: 200 })), 'item, delay 100-200 ms');
		assert.equal(settingsText(crawler({ minDelayMs: 100 })), 'item, min delay 100 ms');
		assert.equal(settingsText(crawler({ maxDelayMs: 900 })), 'item, max delay 900 ms');
		assert.equal(settingsText(crawler({ idleMs: 0 })), 'item, exits when no URLs');
		assert.equal(settingsText(crawler({ idleMs: 5000 })), 'item, waits 5000 ms when no URLs');
	});

	it('shows the type and the proxy in the table row', async () => {
		await configStore.save(configOf(1, [pooled('only', '10.0.0.1:80')]));
		const page = await app.inject({ method: 'GET', url: '/fragments/status', headers });
		assert.match(page.body, /title="item · pool 10\.0\.0\.1:80">item · pool 10\.0\.0\.1:80<\/span>/);
		assert.doesNotMatch(page.body, /workers/);
	});
});

describe('crawler form', () => {
	const form = (setting?: CrawlerSetting) => renderCrawlerForm(setting ? formFromSetting(setting) : emptyForm(), []);

	it('keeps name, type and proxy outside of the "More settings" block', () => {
		const html = form();
		const [before, inside] = html.split('<details');
		assert.match(before, /name="name"/);
		assert.match(before, /name="type"/);
		assert.match(before, /name="proxyKind"/);
		for (const field of ['workers', 'minDelayMs', 'maxDelayMs', 'idleMs', 'reverse']) {
			assert.doesNotMatch(before, new RegExp(`name="${field}"`));
			assert.match(inside, new RegExp(`name="${field}"`));
		}
		assert.match(inside, /More settings/);
	});

	it('shows the defaults as placeholders, taken from the constants', () => {
		const html = form();
		assert.match(html, new RegExp(`name="workers" value="" type="number" min="1" max="64" placeholder="1"`));
		assert.match(html, new RegExp(`name="minDelayMs" value="" type="number" min="0" placeholder="${MIN_REQUEST_DELAY_MS}"`));
		assert.match(html, new RegExp(`name="maxDelayMs" value="" type="number" min="0" placeholder="${MAX_REQUEST_DELAY_MS}"`));
		assert.match(html, new RegExp(`name="idleMs" value="" type="number" min="0" placeholder="${DEFAULT_IDLE_MS}"`));
	});

	it('is closed for a new crawler and for one with only default values', () => {
		assert.doesNotMatch(form(), /<details class="more" open>/);
		assert.match(form(), /<details class="more">/);
		const explicitDefaults = crawler({ minDelayMs: MIN_REQUEST_DELAY_MS, maxDelayMs: MAX_REQUEST_DELAY_MS });
		assert.doesNotMatch(form(explicitDefaults), /<details class="more" open>/);
		assert.equal(hasCustomSettings(formFromSetting(explicitDefaults)), false);
	});

	it('opens when the crawler has a value that is not the default', () => {
		for (const extra of [{ workers: 2 }, { reverse: true }, { minDelayMs: 1 }, { maxDelayMs: 2000 }, { idleMs: 0 }]) {
			assert.match(form(crawler(extra)), /<details class="more" open>/, JSON.stringify(extra));
		}
	});

	it('stores only the values that are not the default', async () => {
		const post = (extra: Record<string, string>) => postForm('/fragments/crawlers', {
			original: '', name: 'f1', type: 'item', workers: '', minDelayMs: '', maxDelayMs: '', idleMs: '', proxyKind: 'none', ...extra,
		});
		await post({});
		assert.deepEqual(saved().crawlers, [{ name: 'f1', type: 'item', proxy: { kind: 'none' } }]);

		// a value that equals the default is not stored either
		await configStore.save(adminConfigSchema.parse({}));
		await post({ workers: '1', minDelayMs: String(MIN_REQUEST_DELAY_MS), maxDelayMs: String(MAX_REQUEST_DELAY_MS) });
		assert.deepEqual(saved().crawlers, [{ name: 'f1', type: 'item', proxy: { kind: 'none' } }]);

		await configStore.save(adminConfigSchema.parse({}));
		await post({ workers: '4', reverse: 'on', minDelayMs: '300', maxDelayMs: String(MAX_REQUEST_DELAY_MS), idleMs: '0' });
		assert.deepEqual(saved().crawlers, [{ name: 'f1', type: 'item', reverse: true, workers: 4, minDelayMs: 300, idleMs: 0, proxy: { kind: 'none' } }]);
	});

	it('still checks the delays before it drops the defaults', async () => {
		const response = await postForm('/fragments/crawlers', {
			original: '', name: 'f2', type: 'item', minDelayMs: '900', maxDelayMs: '800', proxyKind: 'none',
		});
		assert.match(response.body, /class="error"/);
		assert.match(response.body, /<details class="more" open>/);
		assert.deepEqual(saved().crawlers, []);
	});

	it('loads an old config with explicit default values', async () => {
		fs.writeFileSync(configFile, JSON.stringify({
			crawlers: [{ name: 'old', type: 'item', reverse: false, workers: 1, minDelayMs: 400, maxDelayMs: 450, proxy: { kind: 'none' } }],
		}));
		const config = await configStore.load();
		assert.equal(config.crawlers[0].workers, 1);
		assert.equal(config.crawlers[0].minDelayMs, 400);
		const page = await app.inject({ method: 'GET', url: '/fragments/status', headers });
		assert.match(page.body, /delay 400-450 ms/);
	});
});
