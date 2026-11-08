import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { JsonFileConfigStore } from '../config-store';
import { CrawlerStats } from '../crawler-metrics';
import { mergePool, ProxyPoolService } from '../proxy-pool';
import { rateProxies } from '../proxy-performance';
import { CrawlerStatus } from '../supervisor';
import { countryName, flagOf } from '../ui-parts';

const item = (n: number, usedBy: string[] = [`c${n}`]) => ({ key: `10.0.0.${n}:80`, host: `10.0.0.${n}`, port: 80, username: 'u', usedBy });

const crawler = (name: string, saved: number, extra: Partial<CrawlerStats> = {}, state: CrawlerStatus['state'] = 'running'): CrawlerStatus => ({
	name, configured: true, state,
	stats: {
		requestsPerMin: saved + 2, urlsPerMin: saved, http429PerHour: 0, bytesPerHour: 1_000_000, linksPerMin: 1, failedPerMin: 0, failShare: 0,
		totals: { requests: 500, processed: 400, failed: 10, http429: 0, bytes: 5_000_000, newLinks: 5 },
		pauseMs: 0, idle: false, failures: [], reportedAt: 1,
		...extra,
	},
});

describe('rateProxies', () => {
	it('marks the fastest healthy proxy as best, a slow one as slow and keeps the rest ok', () => {
		const speeds = [40, 30, 28, 26, 24, 10];
		const items = speeds.map((_, i) => item(i + 1));
		const result = rateProxies(items, speeds.map((speed, i) => crawler(`c${i + 1}`, speed)));
		assert.equal(result.get(items[0].key)?.verdict, 'best');
		assert.equal(result.get(items[0].key)?.rank, 1);
		assert.equal(result.get(items[2].key)?.verdict, 'ok');
		assert.equal(result.get(items[5].key)?.verdict, 'slow');
		assert.match(result.get(items[5].key)!.reason, /less than half of the median/);
	});

	it('says replace for a blocked proxy, a warning, a rate limited proxy and a failed crawler', () => {
		const items = [1, 2, 3, 4].map(n => item(n));
		const result = rateProxies(items, [
			crawler('c1', 5, { failedPerMin: 4, urlsPerMin: 5, failShare: 0.8 }),
			crawler('c2', 20, { warning: { kind: 'notFound', message: 'control request got 404', since: 1 } }),
			crawler('c3', 20, { http429PerHour: 90 }),
			{ name: 'c4', configured: true, state: 'failed', error: 'exit code 1' },
		]);
		assert.deepEqual(items.map(entry => result.get(entry.key)?.verdict), ['replace', 'replace', 'replace', 'replace']);
		assert.match(result.get(items[0].key)!.reason, /80% of the latest URLs failed/);
		assert.match(result.get(items[2].key)!.reason, /rate limited/);
		assert.match(result.get(items[3].key)!.reason, /exit code 1/);
	});

	it('does not rate a proxy that has little data, a stopped one or a free one', () => {
		const items = [item(1), item(2), item(3, [])];
		const result = rateProxies(items, [
			crawler('c1', 5, { totals: { requests: 5, processed: 3, failed: 1, http429: 0, bytes: 10, newLinks: 0 } }),
			crawler('c2', 5, {}, 'stopped'),
		]);
		assert.deepEqual(items.map(entry => result.get(entry.key)?.verdict), ['learning', 'idle', 'free']);
	});

	it('adds the speed of two crawlers on one proxy and gives the traffic for 1,000 pages', () => {
		const items = [item(1, ['a', 'b'])];
		const perf = rateProxies(items, [crawler('a', 10), crawler('b', 5)]).get(items[0].key)!;
		assert.equal(perf.savedPerMin, 15);
		assert.equal(perf.bytesPerHour, 2_000_000);
		assert.equal(Math.round(perf.bytesPer1000Pages ?? 0), 12_500_000);
	});

	it('does not call a proxy slow or best when too few proxies can be compared', () => {
		const items = [item(1), item(2)];
		const result = rateProxies(items, [crawler('c1', 40), crawler('c2', 2)]);
		assert.deepEqual(items.map(entry => result.get(entry.key)?.verdict), ['ok', 'ok']);
	});
});

describe('country', () => {
	it('makes a flag and a name from a code', () => {
		assert.equal(flagOf('us'), '\u{1F1FA}\u{1F1F8}');
		assert.equal(flagOf('xyz'), '');
		assert.equal(flagOf(undefined), '');
		assert.equal(countryName('DE'), 'Germany');
	});

	it('keeps the country of an entry when an import file updates it', () => {
		const old = [{ host: 'a', port: 1, username: 'u', password: 'p', countryCode: 'US' }];
		const merged = mergePool(old, [{ host: 'a', port: 1, username: 'u2', password: 'p2' }], 'append');
		assert.equal(merged.pool[0].countryCode, 'US');
		assert.equal(merged.pool[0].username, 'u2');
	});

	it('detects countries with the Webshare list and refuses without an API key', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'band-spider-country-'));
		try {
			const store = new JsonFileConfigStore(path.join(dir, 'config.json'));
			const source = { list: async () => [
				{ id: '1', host: '1.1.1.1', port: 80, username: 'u', password: 'p', valid: true, countryCode: 'de' },
			] };
			const service = new ProxyPoolService(store, () => source);
			await service.importList('1.1.1.1:80:u:p\n2.2.2.2:80:u:p', 'append');
			await assert.rejects(service.detectCountries(), /WEBSHARE_API_KEY/);

			// the key can come from the environment, so the admin config does not need it
			const withEnv = new ProxyPoolService(store, apiKey => {
				assert.equal(apiKey, 'from-env');
				return source;
			}, { WEBSHARE_API_KEY: ' from-env ' });
			assert.deepEqual(await withEnv.detectCountries(), { matched: 1, unmatched: 1, total: 2 });
			const list = await service.list();
			assert.equal(list[0].countryCode, 'DE');
			assert.equal(list[1].countryCode, undefined);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
