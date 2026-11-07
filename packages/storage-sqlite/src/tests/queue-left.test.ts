import 'reflect-metadata';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { UrlType } from '@band-spider/core';
import { BandDatabase } from '../db';
import { LocalCrawlStore } from '../local-crawl-store';

const tempDir: string = fs.mkdtempSync(path.join(os.tmpdir(), 'band-spider-queue-left-'));
let db: BandDatabase;
let store: LocalCrawlStore;
// the counted size is kept for a minute, so the tests move this clock past it
let clock = 0;
const later = () => { clock += 61_000; };
// the number of the cache is old: it is counted again in the background, then read
const recount = async (): Promise<{ items: number, accounts: number }> => {
	later();
	await store.queueLeft();
	await store.idle();
	return await store.queueLeft();
};

before(async () => {
	db = await BandDatabase.open({ file: path.join(tempDir, 'queue.sqlite'), synchronize: true });
	store = new LocalCrawlStore(db, 10 * 60_000, () => clock);
});

after(async () => {
	await db.close();
	fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('queueLeft', () => {
	it('is zero for an empty database', async () => {
		assert.deepEqual(await store.queueLeft(), { items: 0, accounts: 0 });
	});

	it('counts only URLs that can be claimed, and counts past the claim limit of 400', async () => {
		for (let n = 0; n < 405; n++) {
			await db.item.insert(`https://q.bandcamp.com/track/${n}`);
		}
		// not a track, so the item filter skips it
		await db.item.insert('https://q.bandcamp.com/album/skipped');
		await db.account.insert('https://bandcamp.com/q-one');
		await db.account.insert('https://bandcamp.com/q-two');

		assert.deepEqual(await recount(), { items: 405, accounts: 2 });

		// a claimed URL is busy, so it is not left
		const [task] = await store.claim(UrlType.Account, 1, false);
		assert.deepEqual(await recount(), { items: 405, accounts: 1 });

		// a processed account is not left either
		await db.query('UPDATE accounts SET lastProcessingDate = unixepoch() WHERE id = ?', [task.id]);
		await store.release(task, 'rateLimited');
		assert.deepEqual(await recount(), { items: 405, accounts: 1 });
	});

	it('reuses the counted size for a minute', async () => {
		const before = await recount();
		await db.item.insert('https://q.bandcamp.com/track/new-one');

		clock += 30_000;
		assert.deepEqual(await store.queueLeft(), before);

		// an old number is returned at once and counted again in the background
		clock += 31_000;
		assert.deepEqual(await store.queueLeft(), before);
		await store.idle();
		assert.deepEqual(await store.queueLeft(), { ...before, items: before.items + 1 });
	});
});
