import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { buildApp } from '../app';
import { adminConfigSchema } from '../config';
import { JsonFileConfigStore } from '../config-store';
import { CrawlerStats } from '../crawler-metrics';
import { SESSION_COOKIE } from '../security';
import { Supervisor, SupervisorStatus } from '../supervisor';
import { attentionItems, STALL_MS } from '../ui-attention';
import { bulkText } from '../ui-bulk';
import { renderCrawlerDetail } from '../ui-detail';
import { failureLabel, mergeFailures } from '../ui-failures';
import { emptyForm, ICONS, renderCrawlerForm, renderProxyList, renderStatus, trendChart } from '../ui-render';
import { CRAWLER_ENTRY, DB_ENTRY, FakeLauncher, readyDbLauncher } from './fakes';

const NOW = 50_000_000;
const PASS = 'pages-secret-pass';

const stats = (extra: Partial<CrawlerStats> = {}): CrawlerStats => ({
	requestsPerMin: 30, urlsPerMin: 20, http429PerHour: 0, bytesPerHour: 3_600_000, linksPerMin: 2,
	totals: { requests: 300, processed: 200, failed: 3, http429: 0, bytes: 1_000_000, newLinks: 40 },
	pauseMs: 0, idle: false, failures: [], reportedAt: NOW - 30_000, ...extra,
});

const config = adminConfigSchema.parse({
	proxyPool: [
		{ host: '10.1.0.1', port: 80, username: 'u', password: PASS },
		{ host: '10.1.0.2', port: 80, username: 'u', password: PASS },
		{ host: '10.1.0.3', port: 80, username: 'u', password: PASS },
	],
	crawlers: [
		{ name: 'a', type: 'item', proxy: { kind: 'pool', key: '10.1.0.1:80' } },
		{ name: 'b', type: 'account', proxy: { kind: 'pool', key: '10.1.0.1:80' } },
		{ name: 'c', type: 'item', proxy: { kind: 'none' } },
	],
});

const status = (crawlers: SupervisorStatus['crawlers']): SupervisorStatus => ({ db: { state: 'running' }, crawlers });

describe('the "Needs attention" list', () => {
	it('is empty when all is well', () => {
		const clean = adminConfigSchema.parse({ crawlers: [{ name: 'a', type: 'item' }] });
		assert.deepEqual(attentionItems(status([{ name: 'a', configured: true, state: 'running', stats: stats() }]), clean, NOW), []);
	});

	it('puts failures first, then warnings, then notes, and names the crawler', () => {
		const items = attentionItems({
			db: { state: 'running', dbStatsError: 'timed out' },
			crawlers: [
				{ name: 'a', configured: true, state: 'running', stats: stats({ idle: true }) },
				{ name: 'b', configured: true, state: 'failed', error: 'proxy refused' },
				{ name: 'c', configured: true, state: 'running', stats: stats({ pauseMs: 30_000, http429PerHour: 75 }) },
			],
		}, config, NOW);
		assert.deepEqual(items.map(item => item.tone), ['bad', 'bad', 'warn', 'warn', 'warn', 'info']);
		assert.deepEqual(items.map(item => item.title), [
			'b: failed',
			'c: too many HTTP 429',
			'DB statistics cannot be read',
			'c: paused after HTTP 429',
			'Proxy 10.1.0.1:80 is shared',
			'a: waiting for URLs',
		]);
		assert.equal(items[0].crawler, 'b');
		assert.equal(items[0].detail, 'proxy refused');
		assert.equal(items[4].crawler, undefined);
	});

	it('finds a crawler that hangs or sends nothing, and one that was removed from the config', () => {
		const items = attentionItems({
			db: { state: 'failed', error: 'port in use' },
			crawlers: [
				{ name: 'a', configured: true, state: 'running', stats: stats({ reportedAt: NOW - STALL_MS - 60_000 }) },
				{ name: 'c', configured: true, state: 'running', stats: stats({ requestsPerMin: 0 }) },
				{ name: 'old', configured: false, state: 'running' },
			],
		}, adminConfigSchema.parse({}), NOW);
		assert.deepEqual(items.map(item => `${item.tone} ${item.title}`), [
			'bad DB service failed',
			'warn a: no report',
			'warn c: no requests',
			'warn old: removed from the config',
		]);
		assert.match(items[1].detail, /4m 00s ago/);
	});
});

describe('bulk action messages', () => {
	it('says what was done, what was skipped and what failed', () => {
		assert.equal(bulkText('start', 1, 0, []), '1 crawler started');
		assert.equal(bulkText('stop', 2, 1, []), '2 crawlers stopped, 1 skipped (not running)');
		assert.equal(bulkText('remove', 0, 2, []), '0 crawlers removed, 2 skipped (still running or not in the config)');
		assert.equal(bulkText('restart', 1, 0, ['x: boom', 'y: boom', 'z: boom', 'w: boom']), '1 crawler restarted, 4 failed: x: boom; y: boom; z: boom');
	});
});

describe('the live pages', () => {
	const page = renderStatus(status([
		{ name: 'a', configured: true, state: 'running', stats: stats({ pauseMs: 5000 }), series: {
			requests: Array(30).fill(1), urls: Array(30).fill(1), http429: Array(30).fill(0), links: Array(30).fill(2), bytes: Array(30).fill(1000),
		} },
		{ name: 'b', configured: true, state: 'failed', error: 'proxy <refused>' },
		{ name: 'c', configured: true, state: 'stopped', stats: stats() },
	]), config, NOW);

	it('has the overview, the crawler table and the traffic page in one block', () => {
		for (const view of ['overview', 'crawlers', 'traffic']) {
			assert.match(page, new RegExp(`class="view" data-view="${view}"`));
		}
		assert.match(page, /data-nav-summary data-running="1" data-total="3" data-failed="1" data-attention="3"/);
		// the chart has one pane for each metric, the page script shows the chosen one
		for (const metric of ['speed', 'links', 'traffic']) {
			assert.match(page, new RegExp(`data-chart-pick="${metric}"`));
			assert.match(page, new RegExp(`data-chart-pane="${metric}"`));
		}
	});

	it('shows what needs attention with a link to the details, escaped', () => {
		assert.match(page, /Needs attention <span class="count count-bad">3<\/span>/);
		assert.match(page, /<b>b: failed<\/b><span class="meta clip" title="proxy &lt;refused&gt;">/);
		assert.match(page, /hx-get="\/fragments\/crawler-detail\?name=b"/);
		assert.doesNotMatch(page, /proxy <refused>/);
	});

	it('shows a pause only while the crawler runs', () => {
		const rows = (state: 'running' | 'stopped') => renderStatus(status([{ name: 'a', configured: true, state, stats: stats({ pauseMs: 5000 }) }]), config, NOW);
		assert.match(rows('running'), /class="pill pill-warn"[^>]*>paused 5s</);
		assert.doesNotMatch(rows('stopped'), /paused 5s/);
	});

	it('has chips with counts, a checkbox of the bulk form and icon buttons in each row', () => {
		assert.match(page, /data-chip="state" data-value="active" aria-pressed="false">Running <b>1<\/b>/);
		assert.match(page, /data-chip="state" data-value="failed" aria-pressed="false">Failed <b>1<\/b>/);
		assert.match(page, /data-chip="type" data-value="item" aria-pressed="false">Items <b>2<\/b>/);
		assert.match(page, /name="names" value="a" form="bulk-form"/);
		assert.match(page, /class="btn-icon btn-warn" title="Stop" aria-label="Stop" hx-post="\/fragments\/crawlers\/a\/stop"/);
		assert.match(page, /class="btn-icon btn-ok" title="Start" aria-label="Start" hx-post="\/fragments\/crawlers\/b\/start"/);
		assert.match(page, /<use href="#i-logs"\/>/);
		assert.match(page, /class="pill pill-bad" title="proxy &lt;refused&gt;">error</);
	});

	it('counts only the traffic of crawlers with a proxy, with the month estimate and the plan box', () => {
		const traffic = /data-view="traffic"[\s\S]*$/.exec(page)![0];
		// a and c have 1 MB each, c uses the local IP
		assert.match(traffic, /Since start<\/span><span class="kpi-value">1\.0 MB<\/span>/);
		assert.match(traffic, /data-plan data-month-bytes="2592000000"/);
		assert.match(traffic, /Not counted, they use the local IP: c/);
		assert.match(traffic, /data-key="traffic:a"/);
		assert.doesNotMatch(traffic, /data-key="traffic:c"/);
	});

	it('draws everything with attributes and classes only, because the page CSP has no inline styles', () => {
		assert.doesNotMatch(page, /\sstyle=/);
		assert.doesNotMatch(page, /\son[a-z]+=/);
		assert.doesNotMatch(page, /<script/);
	});

	it('gives each minute of a chart a tooltip', () => {
		const chart = trendChart([{ label: 'traffic/min', tone: 'traffic', values: [0, 2000] }], 2, 'Traffic', { format: value => `${value} B` });
		assert.match(chart, /<rect class="hit"[^>]*><title>1 min ago: traffic\/min: 0 B<\/title><\/rect>/);
		assert.match(chart, /<title>this minute: traffic\/min: 2000 B<\/title>/);
		assert.match(chart, /peak 2000 B per minute/);
	});
});

describe('the detail drawer of a crawler', () => {
	it('shows the speeds, the counts, the settings and the actions', () => {
		const html = renderCrawlerDetail('a', {
			name: 'a', configured: true, state: 'running', stats: stats({ pauseMs: 65_000 }),
			counts: { claimed: 9, saved: 7, failed: 1, rateLimited: 2, notFound: 0 },
		}, config.crawlers[0], NOW);
		assert.match(html, /data-detail="a"/);
		assert.match(html, /last report 30s ago/);
		assert.match(html, /paused after HTTP 429, 1m 05s left/);
		assert.match(html, /Claimed<\/span><b>9<\/b>/);
		assert.match(html, /Rate limited<\/span><b>2<\/b>/);
		assert.match(html, /Proxy<\/span><b>pool 10\.1\.0\.1:80<\/b>/);
		assert.match(html, /hx-post="\/fragments\/crawlers\/a\/stop"/);
		assert.match(html, /hx-get="\/fragments\/logs\?source=crawler%3Aa"/);
		assert.match(html, /hx-get="\/fragments\/detail-close"/);
		// a running crawler cannot be removed
		assert.match(html, /hx-delete="\/fragments\/crawlers\/a"[^>]* disabled>/);
		assert.doesNotMatch(html, /\sstyle=/);
	});

	it('says so when the crawler is gone, and has no report yet before the first one', () => {
		assert.match(renderCrawlerDetail('gone', undefined, undefined, NOW), /No crawler gone in the config/);
		assert.match(renderCrawlerDetail('a', { name: 'a', configured: true, state: 'starting' }, config.crawlers[0], NOW), /No report yet/);
		// a stopped crawler keeps its last report, but a pause of it is over
		const stopped = renderCrawlerDetail('a', { name: 'a', configured: true, state: 'stopped', stats: stats({ pauseMs: 5000 }) }, config.crawlers[0], NOW);
		assert.doesNotMatch(stopped, /paused after/);
		assert.match(stopped, /hx-post="\/fragments\/crawlers\/a\/start"/);
	});
});

describe('the proxy list', () => {
	const items = [
		{ key: '10.1.0.1:80', host: '10.1.0.1', port: 80, username: 'u', usedBy: ['a', 'b'] },
		{ key: '10.1.0.2:80', host: '10.1.0.2', port: 80, username: 'u', usedBy: [] },
	];

	it('shows the state and the traffic of the crawlers that use a proxy', () => {
		const html = renderProxyList(items, [
			{ name: 'a', configured: true, state: 'running', stats: stats() },
			{ name: 'b', configured: true, state: 'failed' },
		]);
		assert.match(html, /data-pstate="shared"/);
		assert.match(html, /data-pstate="free"/);
		assert.match(html, /<span class="dot state-running"[^>]*><\/span>a<\/button>/);
		assert.match(html, /<span class="dot state-failed"[^>]*><\/span>b<\/button>/);
		assert.match(html, /<b>1\.0 MB<\/b><span class="sub">3\.6 MB\/hour<\/span>/);
		assert.match(html, /data-proxy-chip="shared" aria-pressed="false">Shared <b>1<\/b>/);
		// a used proxy cannot be deleted, the server refuses it anyway
		assert.match(html, /aria-label="Delete 10\.1\.0\.1:80" hx-delete="\/fragments\/proxy-list\/10\.1\.0\.1%3A80"[^>]* disabled>/);
		assert.match(html, /id="chosen-form" class="actionbar"/);
		assert.match(html, /data-open-dialog="import-dialog"/);
	});

	it('has an empty state with the import button', () => {
		const html = renderProxyList([]);
		assert.match(html, /No proxies yet/);
		assert.match(html, /data-open-dialog="import-dialog"/);
		assert.doesNotMatch(html, /chosen-form/);
	});
});

describe('the crawler form', () => {
	it('marks the proxy fields with their kind, so the page shows only the fields of the chosen one', () => {
		const html = renderCrawlerForm(emptyForm(), []);
		assert.match(html, /<label data-for-kind="pool">Pool proxy<select name="poolKey">/);
		assert.match(html, /<label data-for-kind="url">Proxy URL<input name="proxyUrl"/);
		assert.equal((html.match(/data-for-kind="webshare"/g) ?? []).length, 4);
		assert.equal((html.match(/data-for-kind="webshare-list"/g) ?? []).length, 2);
	});
});

describe('the page files', () => {
	const ui = path.join(__dirname, '..', '..', 'ui');

	it('have every icon the renderers use in the sprite of the page', () => {
		const index = fs.readFileSync(path.join(ui, 'index.html'), 'utf8');
		for (const name of ICONS) {
			assert.match(index, new RegExp(`<symbol id="i-${name}"`), name);
		}
		// the theme button switches between these three
		for (const name of ['auto', 'sun', 'moon']) {
			assert.match(index, new RegExp(`<symbol id="i-${name}"`), name);
		}
	});

	it('have no inline script, style or event handler, because of the page CSP', () => {
		const index = fs.readFileSync(path.join(ui, 'index.html'), 'utf8');
		assert.doesNotMatch(index, /\sstyle=/);
		assert.doesNotMatch(index, /\son[a-z]+=/);
		assert.doesNotMatch(index, /<script>(?!<\/script>)/);
		assert.equal((index.match(/<script /g) ?? []).length, (index.match(/<script src="\/assets\//g) ?? []).length);
	});
});

describe('fragment routes of the pages', () => {
	const TOKEN = 'test-token';
	const PORT = 4203;
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'band-spider-admin-pages-'));
	const configStore = new JsonFileConfigStore(path.join(tempDir, 'config.json'));
	let launcher: FakeLauncher;
	let supervisor: Supervisor;
	let app: ReturnType<typeof buildApp>;
	const headers = { host: `127.0.0.1:${PORT}`, cookie: `${SESSION_COOKIE}=${TOKEN}` };
	const get = (url: string) => app.inject({ method: 'GET', url, headers });
	const post = (url: string, body: string) => app.inject({
		method: 'POST',
		url,
		headers: { ...headers, origin: `http://127.0.0.1:${PORT}`, 'content-type': 'application/x-www-form-urlencoded' },
		payload: body,
	});
	const names = (...list: string[]) => list.map(name => `names=${encodeURIComponent(name)}`).join('&');

	before(async () => {
		launcher = readyDbLauncher();
		// a crawler says "started" at once, like a real one after its config
		const ready = launcher.onLaunch;
		launcher.onLaunch = child => {
			ready(child);
			if (child.spec.entry === CRAWLER_ENTRY) {
				child.emit({ type: 'started' });
			}
		};
		await configStore.save(config);
		supervisor = new Supervisor({ launcher, configStore, entries: { dbService: DB_ENTRY, crawler: CRAWLER_ENTRY }, stopTimeoutMs: 50, dbStatsIntervalMs: 0 });
		app = buildApp({ supervisor, configStore, security: { token: TOKEN, port: () => PORT } });
	});

	after(async () => {
		await supervisor.shutdown();
		await app.close();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it('serves the theme script and needs the token for it', async () => {
		const theme = await get('/assets/theme.js');
		assert.equal(theme.statusCode, 200);
		assert.match(theme.headers['content-type'] as string, /javascript/);
		assert.equal((await app.inject({ method: 'GET', url: '/assets/theme.js', headers: { host: headers.host } })).statusCode, 401);
	});

	it('starts the chosen crawlers, and the DB service first', async () => {
		const response = await post('/fragments/bulk/start', names('a', 'c'));
		assert.equal(response.statusCode, 200);
		assert.match(response.body, /2 crawlers started/);
		assert.equal(launcher.of(DB_ENTRY).length, 1);
		assert.equal(launcher.of(CRAWLER_ENTRY).length, 2);
		const again = await post('/fragments/bulk/start', names('a'));
		assert.match(again.body, /0 crawlers started, 1 skipped \(already running\)/);
	});

	it('does not remove a running crawler, and removes a stopped one', async () => {
		const refused = await post('/fragments/bulk/remove', names('a', 'b'));
		assert.match(refused.body, /1 crawler removed, 1 skipped \(still running or not in the config\)/);
		assert.deepEqual((await configStore.load()).crawlers.map(crawler => crawler.name), ['a', 'c']);
		// the pool list is part of the answer, so the proxy shows as free at once
		assert.match(refused.body, /id="proxy-list" hx-swap-oob="morph"/);
		assert.doesNotMatch(refused.body, new RegExp(PASS));
	});

	it('stops the chosen crawlers and says when nothing is chosen', async () => {
		const stopped = await post('/fragments/bulk/stop', names('a', 'c', 'nope'));
		assert.match(stopped.body, /2 crawlers stopped, 1 skipped \(not running\)/);
		assert.match((await post('/fragments/bulk/stop', '')).body, /Choose at least one crawler first/);
		assert.equal((await post('/fragments/bulk/explode', names('a'))).statusCode, 404);
	});

	it('gives the detail drawer of a crawler and closes it', async () => {
		const detail = await get('/fragments/crawler-detail?name=a');
		assert.equal(detail.statusCode, 200);
		assert.match(detail.body, /data-detail="a"/);
		assert.match((await get('/fragments/crawler-detail?name=%3Cb%3E')).body, /No crawler &lt;b&gt; in the config/);
		assert.equal((await get('/fragments/detail-close')).body, '');
	});

	it('shows the state of the crawlers in the proxy list', async () => {
		await post('/fragments/bulk/start', names('a'));
		const list = await get('/fragments/proxy-list');
		assert.match(list.body, /<span class="dot state-running"[^>]*><\/span>a<\/button>/);
		assert.doesNotMatch(list.body, new RegExp(PASS));
	});
});

describe('errors', () => {
	const reasons = (...entries: Array<[string, number]>) => entries.map(([key, count]) => ({ key, count, last: `last ${key}` }));

	it('names the failure keys', () => {
		assert.equal(failureLabel('http:503'), 'HTTP 503 Service Unavailable');
		assert.equal(failureLabel('http:418'), 'HTTP 418');
		assert.equal(failureLabel('network:ECONNRESET'), 'Network error ECONNRESET');
		assert.equal(failureLabel('timeout'), 'Request timeout');
	});

	it('adds the reasons of several crawlers, the biggest first', () => {
		const merged = mergeFailures([reasons(['http:503', 2], ['timeout', 1]), reasons(['http:503', 5]), undefined]);
		assert.deepEqual(merged.map(reason => [reason.key, reason.count]), [['http:503', 7], ['timeout', 1]]);
	});

	it('shows them on the overview and in the crawler detail', () => {
		const crawlers = [{ name: 'a', state: 'running' as const, configured: true, stats: stats({ failures: reasons(['http:403', 4]) }) }];
		const html = renderStatus(status(crawlers), config, NOW);
		assert.match(html, /HTTP 403 Forbidden/);
		const detail = renderCrawlerDetail('a', crawlers[0], config.crawlers[0], NOW);
		assert.match(detail, /Errors since start/);
		assert.match(detail, /last http:403/);
	});
});
