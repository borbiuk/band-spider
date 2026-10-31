import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { BandSpiderOptions, DEFAULT_DB_FILE, PARALLEL_BROWSERS_COUNT, parseOptions, readDatabaseConfig } from '../config';
import { UrlType } from '../models/url-type';

// tests run from `dist/tests`
const scripts: Record<string, string> = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8')).scripts;

const options = (overrides: Partial<BandSpiderOptions> = {}): BandSpiderOptions => ({
	concurrencyBrowsers: 1,
	headless: false,
	type: UrlType.Item,
	docker: false,
	superTag: false,
	browser: false,
	...overrides,
});

describe('parseOptions', () => {
	it('keeps one worker', () => {
		assert.equal(PARALLEL_BROWSERS_COUNT, 1);
	});

	it('gives the defaults without flags', () => {
		assert.deepEqual(parseOptions([]), options());
	});

	it('reads each flag', () => {
		assert.deepEqual(parseOptions(['--headless']), options({ headless: true }));
		assert.deepEqual(parseOptions(['--account']), options({ type: UrlType.Account }));
		assert.deepEqual(parseOptions(['--docker']), options({ docker: true }));
		assert.deepEqual(parseOptions(['--superTag']), options({ superTag: true }));
		assert.deepEqual(parseOptions(['--browser']), options({ browser: true }));
	});

	it('matches whole arguments only', () => {
		assert.deepEqual(parseOptions(['--headless=false', '--Account', 'account', '--supertag']), options());
	});

	const expected: Record<string, BandSpiderOptions> = {
		'db:accounts': options({ headless: true, type: UrlType.Account }),
		'db:items': options({ headless: true }),
		'db:accounts:browser': options({ headless: true, type: UrlType.Account, browser: true }),
		'db:items:browser': options({ headless: true, browser: true }),
		'debug:db:accounts': options({ type: UrlType.Account, browser: true }),
		'debug:db:items': options({ browser: true }),
		'docker:db:accounts': options({ headless: true, type: UrlType.Account, docker: true, browser: true }),
		'docker:db:items': options({ headless: true, docker: true, browser: true }),
		'superTag': options({ superTag: true }),
	};

	for (const [name, want] of Object.entries(expected)) {
		it(`reads the flags of "${name}"`, () => {
			const args = scripts[name].split('node ./dist/index.js')[1].trim().split(/\s+/);
			assert.deepEqual(parseOptions(args), want);
		});
	}
});

describe('readDatabaseConfig', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'band-spider-config-'));
	const existing = path.join(dir, 'existing.sqlite');
	fs.writeFileSync(existing, '');
	const missing = path.join(dir, 'missing.sqlite');

	after(() => fs.rmSync(dir, { recursive: true, force: true }));

	it('uses band_db.sqlite when BAND_DB_PATH is not set', () => {
		assert.equal(DEFAULT_DB_FILE, 'band_db.sqlite');
		assert.equal(readDatabaseConfig({}).file, 'band_db.sqlite');
	});

	it('uses BAND_DB_PATH', () => {
		assert.equal(readDatabaseConfig({ BAND_DB_PATH: existing }).file, existing);
	});

	it('creates the schema only for a new file or with DB_SYNCHRONIZE=true', () => {
		assert.equal(readDatabaseConfig({ BAND_DB_PATH: missing }).synchronize, true);
		assert.equal(readDatabaseConfig({ BAND_DB_PATH: existing }).synchronize, false);
		assert.equal(readDatabaseConfig({ BAND_DB_PATH: existing, DB_SYNCHRONIZE: 'true' }).synchronize, true);
		assert.equal(readDatabaseConfig({ BAND_DB_PATH: existing, DB_SYNCHRONIZE: '1' }).synchronize, false);
	});
});
