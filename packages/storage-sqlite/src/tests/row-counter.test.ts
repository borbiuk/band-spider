import 'reflect-metadata';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { BandDatabase, LocalCrawlStore, WorkerRowCounter } from '../index';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'band-spider-row-counter-'));
const file = path.join(tempDir, 'counter.sqlite');
let db: BandDatabase;
let counter: WorkerRowCounter;

before(async () => {
	db = await BandDatabase.open({ file, synchronize: true });
	counter = new WorkerRowCounter(file);
	for (let n = 1; n <= 5; n++) {
		await db.item.insert(`https://c.bandcamp.com/track/${n}`);
	}
	await db.item.insert('https://c.bandcamp.com/album/not-a-track');
	await db.account.insert('https://bandcamp.com/c-one');
	await db.account.insert('https://bandcamp.com/c-two');
	await db.account.insert('https://bandcamp.com/c-three');
	await db.query('UPDATE items SET lastProcessingDate = unixepoch() WHERE id = 1');
	await db.query('UPDATE items SET isBusy = 1 WHERE id = 2');
	await db.query('UPDATE items SET failedCount = 3 WHERE id = 3');
	await db.query("UPDATE accounts SET lastProcessingDate = unixepoch('2024-01-01') WHERE id = 1");
	await db.query("UPDATE accounts SET lastProcessingDate = unixepoch('2026-06-01') WHERE id = 2");
});

after(async () => {
	await counter.close();
	await db.close();
	fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('WorkerRowCounter', () => {
	it('counts the queue like the repositories do', async () => {
		const here = { items: await db.item.countNotProcessed(), accounts: await db.account.countNotProcessed() };
		assert.deepEqual(here, { items: 2, accounts: 2 });
		assert.deepEqual(await counter.queueLeft(), here);
	});

	it('counts the rows like the repositories do', async () => {
		const here = new LocalCrawlStore(db, undefined, undefined, undefined);
		const expected = await here.totals();
		const counts = await counter.rows();
		assert.deepEqual({ ...expected, countedAt: undefined }, { ...counts, countedAt: undefined });
		assert.equal(counts.items, 6);
		assert.equal(counts.itemsProcessed, 1);
		assert.equal(counts.accountsProcessed, 1);
	});

	it('starts a new worker after the counter was closed and used again', async () => {
		const other = new WorkerRowCounter(file);
		await other.queueLeft();
		await other.close();
		assert.deepEqual(await other.queueLeft(), { items: 2, accounts: 2 });
		await other.close();
	});
});
