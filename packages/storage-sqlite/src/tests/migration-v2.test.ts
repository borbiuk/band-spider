import 'reflect-metadata';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { BandDatabase } from '../db';
import { checkV2, migrateToV2, MigrationReport } from '../migrations/v2';

const Database = require('better-sqlite3');

// tests run from `dist/tests`, the fixtures stay in `src/tests/fixtures`
const SCHEMA_V1 = path.join(__dirname, '../../src/tests/fixtures/schema-v1.sql');

const tempDir: string = fs.mkdtempSync(path.join(os.tmpdir(), 'band-spider-migration-'));
const oldFile = path.join(tempDir, 'old.sqlite');
const newFile = path.join(tempDir, 'new.sqlite');

const seconds = (day: string): number => Date.parse(`${day}T00:00:00Z`) / 1000;
const days = (day: string): number => Date.parse(`${day}T00:00:00Z`) / 86_400_000;

/** A small DB with the old schema and every case the migration handles. */
function createOldDb(): void {
	const db = new Database(oldFile);
	db.exec(fs.readFileSync(SCHEMA_V1, 'utf8'));
	db.exec(`
		INSERT INTO accounts (id, url, lastProcessingDate, isBusy, failedCount) VALUES
			(1, 'https://bandcamp.com/fan-a', '2026-02-01', 0, 0),
			(2, 'https://bandcamp.com/Fan-A', '2026-03-05', 1, 1),
			(3, ' https://bandcamp.com/Spaced ', NULL, 0, 0),
			(4, 'https://bandcamp.com/Upper', NULL, 0, 404);

		INSERT INTO items (id, url, albumId, releaseDate, lastProcessingDate, imageUrl) VALUES
			(11, 'https://x.bandcamp.com/album/a', NULL, NULL, NULL, NULL),
			(10, 'https://x.bandcamp.com/track/t', 11, '2024-03-01', '2026-01-10', 'https://f4.bcbits.com/img/a1_2.jpg'),
			(12, 'https://x.bandcamp.com/', NULL, NULL, NULL, NULL),
			(13, 'https://x.bandcamp.comnull', NULL, NULL, NULL, NULL),
			(14, ' https://x.bandcamp.com/album/a', NULL, NULL, NULL, NULL),
			(15, ' https://y.bandcamp.com/track/s', 12, NULL, NULL, NULL);

		INSERT INTO "items-to-accounts" (itemId, accountId, wishlist) VALUES
			(10, 1, 0), (10, 2, 1),
			(11, 2, 1),
			(12, 1, 0), (13, 3, 0),
			(14, 3, 0), (11, 3, 1);

		INSERT INTO tags (id, name) VALUES (1, 'house');
		INSERT INTO "super-tags" (id, name) VALUES (1, 'electronic');
		INSERT INTO "tags-to-super-tags" (tagId, superTagId) VALUES (1, 1);
		INSERT INTO "items-to-tags" (itemId, tagId) VALUES (10, 1), (12, 1), (14, 1);

		INSERT INTO followers (followerId, followedId) VALUES (1, 4), (2, 4), (1, 2), (4, 3);

		INSERT INTO "account-scans" (accountId, collection, wishlist) VALUES
			(1, 'm1', NULL), (2, 'm2', 'w2'), (3, 'm3', NULL);

		UPDATE sqlite_sequence SET seq = 100 WHERE name = 'accounts';
		UPDATE sqlite_sequence SET seq = 200 WHERE name = 'items';
	`);
	db.close();
}

let report: MigrationReport;
let db: BandDatabase;
const query = (sql: string, params: unknown[] = []): Promise<any[]> => db.query(sql, params);

before(async () => {
	createOldDb();
	report = await migrateToV2(oldFile, newFile);
	db = await BandDatabase.open({ file: newFile, synchronize: false });
});

after(async () => {
	await db.close();
	fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('migration to v2', () => {
	it('makes the schema that TypeORM makes, so a sync changes nothing', async () => {
		const pending = await (db as unknown as { dataSource: { driver: { createSchemaBuilder(): { log(): Promise<{ upQueries: unknown[] }> } } } })
			.dataSource.driver.createSchemaBuilder().log();
		assert.deepEqual(pending.upQueries, []);
	});

	it('reports what it merged and dropped', () => {
		assert.deepEqual(report.merged, { accounts: 1, items: 1 });
		assert.equal(report.droppedItems, 2);
		assert.deepEqual(report.rows, {
			accounts: 3, items: 3, items_to_accounts: 3, items_to_tags: 2, followers: 2,
			tags: 1, super_tags: 1, tags_to_super_tags: 1, account_scans: 2,
		});
	});

	it('merges accounts that differ in case, trims and lower-cases URLs, and converts dates', async () => {
		assert.deepEqual(await query('SELECT id, url, lastProcessingDate, isBusy, failedCount FROM accounts ORDER BY id'), [
			{ id: 1, url: 'https://bandcamp.com/fan-a', lastProcessingDate: seconds('2026-03-05'), isBusy: 0, failedCount: 0 },
			{ id: 3, url: 'https://bandcamp.com/spaced', lastProcessingDate: null, isBusy: 0, failedCount: 0 },
			{ id: 4, url: 'https://bandcamp.com/upper', lastProcessingDate: null, isBusy: 0, failedCount: 404 },
		]);
	});

	it('keeps tracks and albums only, sets the type, trims URLs and converts dates', async () => {
		assert.deepEqual(await query('SELECT id, url, type, albumId, releaseDate, lastProcessingDate, imageUrl FROM items ORDER BY id'), [
			{ id: 10, url: 'https://x.bandcamp.com/track/t', type: 0, albumId: 11, releaseDate: days('2024-03-01'), lastProcessingDate: seconds('2026-01-10'), imageUrl: 'https://f4.bcbits.com/img/a1_2.jpg' },
			{ id: 11, url: 'https://x.bandcamp.com/album/a', type: 1, albumId: null, releaseDate: null, lastProcessingDate: null, imageUrl: null },
			{ id: 15, url: 'https://y.bandcamp.com/track/s', type: 0, albumId: null, releaseDate: null, lastProcessingDate: null, imageUrl: null },
		]);
	});

	it('moves links to the merged rows, drops links of dropped items, and a purchase wins over a wishlist', async () => {
		assert.deepEqual(await query('SELECT accountId, itemId, wishlist, addedAt FROM items_to_accounts ORDER BY accountId, itemId'), [
			{ accountId: 1, itemId: 10, wishlist: 0, addedAt: null },
			{ accountId: 1, itemId: 11, wishlist: 1, addedAt: null },
			{ accountId: 3, itemId: 11, wishlist: 0, addedAt: null },
		]);
		assert.deepEqual(await query('SELECT itemId, tagId FROM items_to_tags ORDER BY itemId'), [
			{ itemId: 10, tagId: 1 },
			{ itemId: 11, tagId: 1 },
		]);
	});

	it('merges followers and drops a follow of an account by itself', async () => {
		assert.deepEqual(await query('SELECT followerId, followedId FROM followers ORDER BY followerId'), [
			{ followerId: 1, followedId: 4 },
			{ followerId: 4, followedId: 3 },
		]);
	});

	it('keeps the scan marks of the kept account', async () => {
		assert.deepEqual(await query('SELECT accountId, collection, wishlist FROM account_scans ORDER BY accountId'), [
			{ accountId: 1, collection: 'm1', wishlist: null },
			{ accountId: 3, collection: 'm3', wishlist: null },
		]);
	});

	it('keeps the id sequences, so new rows get ids after the old maximum', async () => {
		const { entity: account } = await db.account.insert('https://bandcamp.com/after-migration');
		const { entity: item } = await db.item.insert('https://z.bandcamp.com/track/after-migration');
		assert.deepEqual([account.id, item.id], [101, 201]);
	});

	it('builds the secondary indexes and leaves the file in WAL mode', async () => {
		const indexes = (await query("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%' ORDER BY name")).map(x => x.name);
		assert.deepEqual(indexes, ['idx_items_album', 'idx_items_to_accounts_item']);
		assert.equal((await query('PRAGMA journal_mode'))[0].journal_mode, 'wal');
	});

	it('passes the integrity and foreign key checks', () => {
		assert.deepEqual(checkV2(newFile), { integrity: [], foreignKeys: [] });
	});

	it('does not overwrite a new file, and does not take a file without the old schema', async () => {
		await assert.rejects(migrateToV2(oldFile, newFile), /exists already/);
		await assert.rejects(migrateToV2(newFile, path.join(tempDir, 'other.sqlite')), /does not have the schema before v2/);
		assert.equal(fs.existsSync(path.join(tempDir, 'other.sqlite')), false);
	});
});
