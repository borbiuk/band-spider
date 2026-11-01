import 'reflect-metadata';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { BandDatabase } from '../db';
import { LocalCrawlStore } from '../local-crawl-store';

const tempDir: string = fs.mkdtempSync(path.join(os.tmpdir(), 'band-spider-totals-'));
let db: BandDatabase;
let store: LocalCrawlStore;
// the counted numbers are kept for five minutes, so the tests move this clock past it
let clock = 0;
const later = () => { clock += 6 * 60_000; };

before(async () => {
	db = await BandDatabase.open({ file: path.join(tempDir, 'totals.sqlite'), synchronize: true });
	store = new LocalCrawlStore(db, 10 * 60_000, () => clock);
});

after(async () => {
	await db.close();
	fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('totals', () => {
	it('is zero for an empty database', async () => {
		const totals = await store.totals();
		assert.deepEqual({ ...totals, countedAt: undefined }, {
			countedAt: undefined, items: 0, itemsProcessed: 0, accounts: 0, accountsProcessed: 0,
			itemAccountRelations: 0, wishlistRelations: 0, followers: 0,
		});
	});

	it('counts rows, processed rows, wishlist links and followers', async () => {
		for (let n = 1; n <= 3; n++) {
			await db.item.insert(`https://t.bandcamp.com/track/${n}`);
		}
		await db.account.insert('https://bandcamp.com/t-one');
		await db.account.insert('https://bandcamp.com/t-two');
		const itemIds = (await db.query('SELECT id FROM items ORDER BY id')).map(row => row.id as number);
		const [first, second] = (await db.query('SELECT id FROM accounts ORDER BY id')).map(row => row.id as number);
		await db.account.addItems(first, itemIds, false);
		await db.account.addItems(second, itemIds.slice(0, 1), true);
		await db.query('INSERT INTO followers (followerId, followedId) VALUES (?, ?)', [first, second]);
		await db.query('UPDATE items SET lastProcessingDate = CURRENT_DATE WHERE id = ?', [itemIds[0]]);
		// an account processed before the re-process date counts as not processed
		await db.query("UPDATE accounts SET lastProcessingDate = '2024-01-01' WHERE id = ?", [first]);
		await db.query("UPDATE accounts SET lastProcessingDate = '2025-01-01' WHERE id = ?", [second]);

		later();
		const totals = await store.totals();
		assert.equal(totals.items, 3);
		assert.equal(totals.itemsProcessed, 1);
		assert.equal(totals.accounts, 2);
		assert.equal(totals.accountsProcessed, 1);
		assert.equal(totals.itemAccountRelations, 4);
		assert.equal(totals.wishlistRelations, 1);
		assert.equal(totals.followers, 1);
	});

	it('reuses the counted numbers for five minutes', async () => {
		later();
		const first = await store.totals();
		await db.item.insert('https://t.bandcamp.com/track/99');
		assert.equal((await store.totals()).items, first.items);
		later();
		assert.equal((await store.totals()).items, first.items + 1);
	});
});
