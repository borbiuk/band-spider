import assert from 'node:assert/strict';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { AdminConfig, adminConfigSchema } from '../config';
import { ConfigStore } from '../config-store';
import { maskConfig, restoreSecrets, SECRET_MASK } from '../secrets';
import { Supervisor } from '../supervisor';
import { pickProxy, WebshareProxySource } from '../webshare';
import { CRAWLER_ENTRY, DB_ENTRY, readyDbLauncher } from './fakes';

const KEY = 'fake-api-key-123';

const row = (n: number, valid = true) => ({
	id: `id${n}`, username: `user${n}`, password: `pa$$${n}`, proxy_address: `10.0.0.${n}`, port: 8000 + n,
	valid, country_code: 'US',
});

describe('WebshareProxySource', () => {
	const requests: Array<{ url: string; auth?: string }> = [];
	let server: http.Server;
	let base: string;
	let mode: 'ok' | 'denied' | 'other-host' = 'ok';

	before(async () => {
		server = http.createServer((req, res) => {
			requests.push({ url: req.url ?? '', auth: req.headers.authorization });
			if (mode === 'denied' || req.headers.authorization !== `Token ${KEY}`) {
				res.writeHead(401).end('{}');
				return;
			}
			const url = new URL(req.url ?? '', base);
			const page = Number(url.searchParams.get('page'));
			const next = mode === 'other-host'
				? 'http://example.invalid/api/v2/proxy/list/?page=2'
				: page === 1 ? `${base}/api/v2/proxy/list/?mode=direct&page=2&page_size=2` : null;
			const results = page === 1 ? [row(1), row(2, false)] : [row(3)];
			res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ count: 3, next, previous: null, results }));
		});
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	});

	after(() => {
		server.close();
	});

	it('sends the token header, follows the pages and keeps only valid proxies', async () => {
		requests.length = 0;
		const entries = await new WebshareProxySource({ apiKey: KEY, baseUrl: base, pageSize: 2 }).list();
		assert.deepEqual(entries.map(entry => entry.id), ['id1', 'id3']);
		assert.equal(entries[0].host, '10.0.0.1');
		assert.equal(requests.length, 2);
		assert.ok(requests[0].url.startsWith('/api/v2/proxy/list/?mode=direct&page=1&page_size=2'));
		assert.ok(requests.every(request => request.auth === `Token ${KEY}`));
	});

	it('does not leak the key in an error', async () => {
		mode = 'denied';
		await assert.rejects(
			new WebshareProxySource({ apiKey: KEY, baseUrl: base }).list(),
			(error: Error) => /refused the API key/.test(error.message) && !error.message.includes(KEY),
		);
		mode = 'ok';
	});

	it('refuses a next link to another host', async () => {
		mode = 'other-host';
		await assert.rejects(new WebshareProxySource({ apiKey: KEY, baseUrl: base }).list(), /another host/);
		mode = 'ok';
	});

	it('picks a proxy by id or by index', () => {
		const entries = [1, 2, 3].map(n => ({ ...row(n), host: row(n).proxy_address, valid: true }));
		assert.equal(pickProxy(entries, { id: 'id2' }).id, 'id2');
		assert.equal(pickProxy(entries, { index: 2 }).id, 'id3');
		assert.throws(() => pickProxy(entries, { index: 5 }), /No Webshare proxy/);
		assert.throws(() => pickProxy(entries, { id: 'nope' }), /No Webshare proxy/);
	});

	it('gives the crawler the resolved proxy URL and masks the key', async () => {
		let config: AdminConfig = adminConfigSchema.parse({
			webshare: { apiKey: KEY },
			crawlers: [{ name: 'a', type: 'item', proxy: { kind: 'webshare-list', id: 'id3' } }],
		});
		const store: ConfigStore = { load: async () => config, save: async next => { config = next; } };
		const launcher = readyDbLauncher();
		const supervisor = new Supervisor({
			launcher, configStore: store, entries: { dbService: DB_ENTRY, crawler: CRAWLER_ENTRY },
			proxyListFactory: apiKey => new WebshareProxySource({ apiKey, baseUrl: base }),
		});
		await supervisor.startCrawler('a');
		const sent = launcher.of(CRAWLER_ENTRY)[0].sent[0] as { config: { proxy: string } };
		assert.equal(sent.config.proxy, 'http://user3:pa%24%243@10.0.0.3:8003');

		const masked = maskConfig(config);
		assert.equal(masked.webshare?.apiKey, SECRET_MASK);
		assert.equal(restoreSecrets(masked, config).webshare?.apiKey, KEY);
		assert.throws(() => restoreSecrets(masked, adminConfigSchema.parse({})), /Webshare API key/);
	});

	it('fails the start when there is no API key', async () => {
		const config = adminConfigSchema.parse({
			crawlers: [{ name: 'a', type: 'item', proxy: { kind: 'webshare-list', index: 0 } }],
		});
		const supervisor = new Supervisor({
			launcher: readyDbLauncher(),
			configStore: { load: async () => config, save: async () => undefined },
			entries: { dbService: DB_ENTRY, crawler: CRAWLER_ENTRY },
		});
		await assert.rejects(supervisor.startCrawler('a'), /No Webshare API key/);
		assert.equal((await supervisor.status()).crawlers[0].state, 'failed');
	});

	it('needs an index or an id, not both', () => {
		const parse = (proxy: object) => adminConfigSchema.safeParse({ crawlers: [{ name: 'a', type: 'item', proxy }] }).success;
		assert.equal(parse({ kind: 'webshare-list' }), false);
		assert.equal(parse({ kind: 'webshare-list', index: 1, id: 'x' }), false);
		assert.equal(parse({ kind: 'webshare-list', index: 1 }), true);
	});
});
