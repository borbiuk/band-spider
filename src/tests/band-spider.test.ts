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
});
