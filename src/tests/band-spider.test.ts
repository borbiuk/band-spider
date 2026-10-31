import 'reflect-metadata';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { parseOptions } from '../config';
import { BandSpider } from '../core/band-spider';
import { BandDatabase } from '../data/db';

const tempDir: string = fs.mkdtempSync(path.join(os.tmpdir(), 'band-spider-run-'));
let db: BandDatabase;

before(async () => {
	db = await BandDatabase.open({ file: path.join(tempDir, 'run.sqlite'), synchronize: true });
});

after(async () => {
	await db.close();
	fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('BandSpider.run', () => {
	it('takes no URL when the stop signal is already aborted', async () => {
		const url = 'https://band.bandcamp.com/track/not-read';
		await db.item.insert(url);
		const stop = new AbortController();
		stop.abort();

		// a request would fail the item: fetch must not be called
		const fetchMock = async () => { throw new Error('no request expected'); };
		const realFetch = globalThis.fetch;
		globalThis.fetch = fetchMock as typeof fetch;
		try {
			await new BandSpider(db).run(parseOptions([]), stop.signal);
		} finally {
			globalThis.fetch = realFetch;
		}

		const [row] = await db.query('SELECT lastProcessingDate, failedCount, isBusy FROM items WHERE url = ?', [url]);
		assert.deepEqual(row, { lastProcessingDate: null, failedCount: 0, isBusy: 0 });
	});

	// tests run from `dist/tests`, the fixtures stay in `src/tests/fixtures`
	const fixture = (name: string): string => fs.readFileSync(path.join(__dirname, '../../src/tests/fixtures', name), 'utf8');

	/** Runs the spider with `answer` in place of the network. The run stops after the first request. */
	const runWith = async (args: string[], answer: (url: string) => Response): Promise<void> => {
		const stop = new AbortController();
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async (input: string | URL | Request) => {
			stop.abort();
			return answer(String(input));
		}) as typeof fetch;
		try {
			await new BandSpider(db).run(parseOptions(args), stop.signal);
		} finally {
			globalThis.fetch = realFetch;
		}
	};

	const itemRow = async (url: string) =>
		(await db.query('SELECT lastProcessingDate IS NOT NULL AS processed, failedCount, isBusy FROM items WHERE url = ?', [url]))[0];
	const accountRow = async (url: string) =>
		(await db.query('SELECT lastProcessingDate IS NOT NULL AS processed, failedCount, isBusy FROM accounts WHERE url = ?', [url]))[0];

	// only the row a test inserts is a candidate: the queue takes a random one
	const reset = async () => {
		await db.query('UPDATE items SET lastProcessingDate = CURRENT_DATE WHERE lastProcessingDate IS NULL');
		await db.query('UPDATE accounts SET lastProcessingDate = CURRENT_DATE WHERE lastProcessingDate IS NULL');
	};

	it('an item page that is read and saved is processed and released', async () => {
		await reset();
		const url = 'https://band.bandcamp.com/track/we-rise';
		await db.item.insert(url);

		await runWith([], () => new Response(fixture('item-track.html'), { status: 200 }));

		assert.deepEqual(await itemRow(url), { processed: 1, failedCount: 0, isBusy: 0 });
	});

	it('an item page that cannot be read is marked failed and released', async () => {
		await reset();
		const url = 'https://band.bandcamp.com/track/broken';
		await db.item.insert(url);

		await runWith([], () => new Response('', { status: 500 }));

		assert.deepEqual(await itemRow(url), { processed: 0, failedCount: 1, isBusy: 0 });
	});

	it('an item page answered with 429 is only released', async () => {
		await reset();
		const url = 'https://band.bandcamp.com/track/limited';
		await db.item.insert(url);

		await runWith([], () => new Response('', { status: 429, headers: { 'retry-after': '1' } }));

		assert.deepEqual(await itemRow(url), { processed: 0, failedCount: 0, isBusy: 0 });
	});

	it('an account page that cannot be read is marked failed and released', async () => {
		await reset();
		const url = 'https://bandcamp.com/run-fan';
		await db.account.insert(url);

		await runWith(['--account'], () => new Response('', { status: 404 }));

		assert.deepEqual(await accountRow(url), { processed: 0, failedCount: 1, isBusy: 0 });
	});
});
