import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { adminConfigSchema, defaultAdminConfig, proxyUrlOf } from '../config';
import { defaultConfigPath, JsonFileConfigStore } from '../config-store';
import { LogRingBuffer } from '../ring-buffer';

const tempDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'band-spider-admin-'));

describe('admin config', () => {
	it('fills the defaults', () => {
		const config = adminConfigSchema.parse({ crawlers: [{ name: 'c1', type: 'item' }] });
		assert.equal(config.dbService.port, 4100);
		assert.deepEqual(config.crawlers[0], { name: 'c1', type: 'item', reverse: false, workers: 1, proxy: { kind: 'none' } });
	});

	it('refuses a duplicate name, a bad delay range and a bad proxy', () => {
		assert.equal(adminConfigSchema.safeParse({
			crawlers: [{ name: 'a', type: 'item' }, { name: 'A', type: 'account' }],
		}).success, false);
		assert.equal(adminConfigSchema.safeParse({
			crawlers: [{ name: 'a', type: 'item', minDelayMs: 500, maxDelayMs: 100 }],
		}).success, false);
		assert.equal(adminConfigSchema.safeParse({
			crawlers: [{ name: 'a', type: 'item', proxy: { kind: 'url', url: 'not a url' } }],
		}).success, false);
		assert.equal(adminConfigSchema.safeParse({
			crawlers: [{ name: 'a', type: 'item', workers: 0 }],
		}).success, false);
	});

	it('builds the proxy URL', () => {
		assert.equal(proxyUrlOf({ kind: 'none' }), undefined);
		assert.equal(proxyUrlOf({ kind: 'url', url: 'http://p:8080' }), 'http://p:8080');
		assert.equal(
			proxyUrlOf({ kind: 'webshare', entry: { host: '1.2.3.4', port: 80, username: 'u s', password: 'p@ss' } }),
			'http://u%20s:p%40ss@1.2.3.4:80',
		);
	});
});

describe('JsonFileConfigStore', () => {
	it('returns the defaults when the file does not exist', async () => {
		const store = new JsonFileConfigStore(path.join(tempDir(), 'none.json'));
		assert.deepEqual(await store.load(), defaultAdminConfig());
	});

	it('saves and loads, and creates the folder', async () => {
		const file = path.join(tempDir(), 'deep', 'config.json');
		const store = new JsonFileConfigStore(file);
		const config = adminConfigSchema.parse({
			dbService: { port: 0, token: 't' },
			crawlers: [{ name: 'c1', type: 'account', reverse: true, workers: 3, proxy: { kind: 'url', url: 'http://p:1' } }],
		});
		await store.save(config);
		assert.deepEqual(await store.load(), config);
		assert.deepEqual(fs.readdirSync(path.dirname(file)), ['config.json']);
	});

	it('rejects a broken file', async () => {
		const file = path.join(tempDir(), 'bad.json');
		fs.writeFileSync(file, JSON.stringify({ crawlers: [{ name: '!', type: 'item' }] }));
		await assert.rejects(new JsonFileConfigStore(file).load(), /invalid/);
	});

	it('takes the path from the environment and defaults to the home folder', () => {
		assert.equal(defaultConfigPath({ ADMIN_CONFIG_PATH: '/x/y.json' }), '/x/y.json');
		assert.equal(defaultConfigPath({}), path.join(os.homedir(), '.band-spider', 'admin-config.json'));
	});
});

describe('LogRingBuffer', () => {
	it('keeps the last lines and joins split chunks', () => {
		const buffer = new LogRingBuffer(3);
		buffer.append('a\nb\nc');
		buffer.append('c\nd\n');
		assert.deepEqual(buffer.snapshot(), ['b', 'cc', 'd']);
		buffer.append('e');
		assert.deepEqual(buffer.snapshot(), ['cc', 'd', 'e']);
		assert.deepEqual(buffer.snapshot(2), ['d', 'e']);
	});
});
