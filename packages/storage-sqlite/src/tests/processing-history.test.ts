import 'reflect-metadata';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { BandDatabase, LocalCrawlStore, WorkerRowCounter } from '../index';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'band-spider-processing-history-'));
const file = path.join(tempDir, 'history.sqlite');
let db: BandDatabase;
let counter: WorkerRowCounter;
// the counted months are kept for half an hour, so the tests move this clock past it
let clock = 0;

before(async () => {
	db = await BandDatabase.open({ file, synchronize: true });
	counter = new WorkerRowCounter(file);
	for (let n = 1; n <= 4; n++) {
		await db.item.insert(`https://h.bandcamp.com/track/${n}`);
	}
	await db.account.insert('https://bandcamp.com/h-one');
	await db.account.insert('https://bandcamp.com/h-two');
	await db.account.insert('https://bandcamp.com/h-three');
	// items: two in January 2026 (one at the last second of the month), one in March, one never
	await db.query("UPDATE items SET lastProcessingDate = unixepoch('2026-01-01') WHERE id = 1");
	await db.query("UPDATE items SET lastProcessingDate = unixepoch('2026-01-31 23:59:59') WHERE id = 2");
	await db.query("UPDATE items SET lastProcessingDate = unixepoch('2026-03-15') WHERE id = 3");
	// accounts: one in December 2025, two never
	await db.query("UPDATE accounts SET lastProcessingDate = unixepoch('2025-12-31 23:59:59') WHERE id = 1");
});

after(async () => {
	await counter.close();
	await db.close();
	fs.rmSync(tempDir, { recursive: true, force: true });
});

const EXPECTED = {
	items: { total: 4, months: [{ month: '2026-01', count: 2 }, { month: '2026-03', count: 1 }] },
	accounts: { total: 3, months: [{ month: '2025-12', count: 1 }] },
};

describe('processing history', () => {
	it('counts the rows by the month of the last processing in a worker thread', async () => {
		assert.deepEqual(await counter.processingHistory(), EXPECTED);
	});

	it('gives the same numbers on the connection of the process', async () => {
		const here = new LocalCrawlStore(db, undefined, () => clock, undefined);
		const history = await here.processingHistory();
		assert.deepEqual({ items: history.items, accounts: history.accounts }, EXPECTED);
	});

	it('keeps the never processed rows in the total and out of the months', async () => {
		const history = await counter.processingHistory();
		const processed = history.items.months.reduce((sum, entry) => sum + entry.count, 0);
		assert.equal(history.items.total - processed, 1);
		assert.ok(history.items.months.every(entry => /^\d{4}-\d{2}$/.test(entry.month)));
	});

	it('is empty for an empty table', async () => {
		const emptyFile = path.join(tempDir, 'empty.sqlite');
		const empty = await BandDatabase.open({ file: emptyFile, synchronize: true });
		const emptyCounter = new WorkerRowCounter(emptyFile);
		try {
			assert.deepEqual(await emptyCounter.processingHistory(), { items: { total: 0, months: [] }, accounts: { total: 0, months: [] } });
		} finally {
			await emptyCounter.close();
			await empty.close();
		}
	});

	it('reuses the counted months for half an hour and counts again after that', async () => {
		const store = new LocalCrawlStore(db, undefined, () => clock, counter);
		const first = await store.processingHistory();
		await db.query("UPDATE items SET lastProcessingDate = unixepoch('2026-05-05') WHERE id = 4");

		clock += 29 * 60_000;
		assert.deepEqual((await store.processingHistory()).items, first.items, 'a number under half an hour old is reused');

		// the cache is old: the answer is still the old one, and the months are counted again in the background
		clock += 2 * 60_000;
		assert.deepEqual((await store.processingHistory()).items, first.items);
		await store.idle();
		const fresh = await store.processingHistory();
		assert.deepEqual(fresh.items.months.map(entry => entry.month), ['2026-01', '2026-03', '2026-05']);
		assert.ok(fresh.countedAt.getTime() > first.countedAt.getTime());
	});
});
