import 'reflect-metadata';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { saveAccountPageData } from '../core/account/clients/account-db-client';
import { AccountPageData } from '../core/account/models/account-page-data';
import { saveItemPageData } from '../core/item/clients/item-db-client';
import { ItemPageData } from '../core/item/models/item-page-data';
import { BandDatabase } from '../data/db';

// tests run from `dist/tests`, the fixtures stay in `src/tests/fixtures`
const SCHEMA_FIXTURE = path.join(__dirname, '../../src/tests/fixtures/schema.json');

const tempDir: string = fs.mkdtempSync(path.join(os.tmpdir(), 'band-spider-test-'));
const tempDbFile: string = path.join(tempDir, 'test.sqlite');

let db: BandDatabase;

const query = (sql: string, params: unknown[] = []): Promise<any[]> => db.query(sql, params);
const count = async (table: string): Promise<number> => (await query(`SELECT COUNT(*) AS n FROM "${table}"`))[0].n;
const itemByUrl = async (url: string): Promise<any> => (await query('SELECT * FROM items WHERE url = ?', [url]))[0];

before(async () => {
	db = await BandDatabase.open({ file: tempDbFile, synchronize: true });
});

after(async () => {
	await db.close();
	fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('database setup', () => {
	it('creates the given file', () => {
		assert.ok(fs.existsSync(tempDbFile));
	});

	it('creates the same schema for a new file', async () => {
		const schema = await query(`SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`);

		// run with UPDATE_SCHEMA_SNAPSHOT=1 only when a schema change is intended
		if (process.env.UPDATE_SCHEMA_SNAPSHOT === '1') {
			fs.writeFileSync(SCHEMA_FIXTURE, JSON.stringify(schema, null, '\t') + '\n');
		}

		assert.deepEqual(schema, JSON.parse(fs.readFileSync(SCHEMA_FIXTURE, 'utf8')));
	});

	it('applies the SQLite pragmas', async () => {
		const pragma = async (name: string) => Object.values((await query(`PRAGMA ${name}`))[0])[0];

		assert.equal(await pragma('journal_mode'), 'wal');
		assert.equal(await pragma('synchronous'), 1, 'NORMAL');
		assert.equal(await pragma('cache_size'), -512 * 1024);
		assert.equal(await pragma('temp_store'), 2, 'MEMORY');
		assert.equal(await pragma('busy_timeout'), 5000);
		assert.equal(await pragma('mmap_size'), 2147418112, '8 GB asked, SQLite clamps it to its MAX_MMAP_SIZE (about 2 GB)');
		assert.equal(await pragma('foreign_keys'), 1);
	});
});

describe('reopening an existing file', () => {
	it('applies the same pragmas without a schema sync', async () => {
		const file = path.join(tempDir, 'reopen.sqlite');
		await (await BandDatabase.open({ file, synchronize: true })).close();

		const reopened = await BandDatabase.open({ file, synchronize: false });
		try {
			const pragma = async (name: string) => Object.values((await reopened.query(`PRAGMA ${name}`))[0])[0];
			assert.deepEqual(
				[await pragma('journal_mode'), await pragma('synchronous'), await pragma('cache_size'), await pragma('temp_store'), await pragma('busy_timeout'), await pragma('mmap_size')],
				['wal', 1, -512 * 1024, 2, 5000, 2147418112],
			);
			assert.equal((await reopened.query('SELECT COUNT(*) AS n FROM items'))[0].n, 0);
		} finally {
			await reopened.close();
		}
	});
});

describe('transactions', () => {
	it('commits everything written through the transaction database', async () => {
		const urls = ['https://tx.bandcamp.com/album/a', 'https://tx.bandcamp.com/album/b'];

		const result = await db.transaction(async (tx) => {
			await tx.item.insertMany(urls);
			await tx.account.insert('https://bandcamp.com/tx-fan');
			return 'done';
		});

		assert.equal(result, 'done');
		assert.equal((await query('SELECT COUNT(*) AS n FROM items WHERE url LIKE ?', ['https://tx.bandcamp.com/%']))[0].n, 2);
		assert.ok(await query('SELECT id FROM accounts WHERE url = ?', ['https://bandcamp.com/tx-fan']).then(x => x.length === 1));
	});

	it('rolls back everything when the work throws', async () => {
		await assert.rejects(db.transaction(async (tx) => {
			await tx.item.insertMany(['https://rollback.bandcamp.com/album/a']);
			await tx.account.insert('https://bandcamp.com/rollback-fan');
			throw new Error('stop');
		}), { message: 'stop' });

		assert.deepEqual(await query('SELECT id FROM items WHERE url LIKE ?', ['https://rollback.bandcamp.com/%']), []);
		assert.deepEqual(await query('SELECT id FROM accounts WHERE url = ?', ['https://bandcamp.com/rollback-fan']), []);
	});
});

describe('close', () => {
	it('closes the connection and can be called twice', async () => {
		const file = path.join(tempDir, 'close.sqlite');
		const other = await BandDatabase.open({ file, synchronize: true });

		await other.close();
		await other.close();
		await assert.rejects(other.query('SELECT 1'));
	});
});

describe('repositories', () => {
	it('account.insert adds a row once', async () => {
		const url = 'https://bandcamp.com/repo-fan';

		const first = await db.account.insert(url);
		const second = await db.account.insert(url);

		assert.equal(first.isInserted, true);
		assert.equal(typeof first.entity.id, 'number');
		assert.equal(second.isInserted, false);
		assert.equal(second.entity.id, first.entity.id);
		assert.equal(second.entity.url, url);
		assert.equal(second.entity.isBusy, false);
		assert.equal(second.entity.failedCount, 0);
	});

	it('item.insert adds a row once and returns the URL', async () => {
		const url = 'https://band.bandcamp.com/track/repo';

		const first = await db.item.insert(url);
		const second = await db.item.insert(url);

		assert.deepEqual([first.isInserted, first.entity.url], [true, url]);
		assert.deepEqual([second.isInserted, second.entity.id], [false, first.entity.id]);
	});

	it('tag.insert stores the name in lower case', async () => {
		const first = await db.tag.insert('Deep House');
		const second = await db.tag.insert('deep house');

		assert.deepEqual([first.isInserted, first.entity.name], [true, 'deep house']);
		assert.deepEqual([second.isInserted, second.entity.id], [false, first.entity.id]);
	});

	it('account.addItem adds a relation once and updates the wishlist flag', async () => {
		const { entity: account } = await db.account.insert('https://bandcamp.com/add-item');
		const { entity: item } = await db.item.insert('https://band.bandcamp.com/album/add-item');
		const wishlist = async () => (await query('SELECT wishlist FROM "items-to-accounts" WHERE accountId = ? AND itemId = ?', [account.id, item.id]))[0].wishlist;

		assert.equal(await db.account.addItem(account.id, item.id), true);
		assert.equal(await wishlist(), 0);
		assert.equal(await db.account.addItem(account.id, item.id), false);
		assert.equal(await db.account.addItem(account.id, item.id, true), false);
		assert.equal(await wishlist(), 1);
	});

	it('item.insertMany keeps the order, repeats ids for duplicates and works past one batch', async () => {
		const urls = Array.from({ length: 600 }, (_, i) => `https://many.bandcamp.com/album/a${i}`);
		const existing = await db.item.insert(urls[10]);

		const first = await db.item.insertMany([...urls, urls[0]]);
		const second = await db.item.insertMany(urls);

		assert.equal(first.ids.length, 601);
		assert.equal(first.ids[600], first.ids[0]);
		assert.equal(first.ids[10], existing.entity.id);
		assert.equal(new Set(first.ids).size, 600);
		assert.equal(first.newUrls.length, 599);
		assert.ok(!first.newUrls.includes(urls[10]));
		assert.deepEqual(second.ids, first.ids.slice(0, 600));
		assert.deepEqual(second.newUrls, []);
	});

	it('account.addItems counts new relations only and updates the wishlist flag', async () => {
		const { entity: account } = await db.account.insert('https://bandcamp.com/add-items');
		const urls = Array.from({ length: 600 }, (_, i) => `https://add-items.bandcamp.com/album/a${i}`);
		const { ids } = await db.item.insertMany(urls);

		assert.equal(await db.account.addItems(account.id, [...ids, ids[0], ids[1]], false), 600);
		assert.equal(await db.account.addItems(account.id, ids, true), 0);

		const rows = await query('SELECT wishlist, COUNT(*) AS n FROM "items-to-accounts" WHERE accountId = ? GROUP BY wishlist', [account.id]);
		assert.deepEqual(rows, [{ wishlist: 1, n: 600 }]);
	});

	it('account.addFollower adds a relation once', async () => {
		const { entity: a } = await db.account.insert('https://bandcamp.com/follow-a');
		const { entity: b } = await db.account.insert('https://bandcamp.com/follow-b');

		assert.equal(await db.account.addFollower(a.id, b.id), true);
		assert.equal(await db.account.addFollower(a.id, b.id), false);
		assert.equal(await db.account.addFollower(b.id, a.id), true);
	});

	it('updateFailed, updateBusy and resetAllBusy', async () => {
		const { entity: item } = await db.item.insert('https://band.bandcamp.com/album/flags');
		const { entity: account } = await db.account.insert('https://bandcamp.com/flags');
		const row = async (table: string, id: number) => (await query(`SELECT isBusy, failedCount FROM ${table} WHERE id = ?`, [id]))[0];

		await db.item.updateFailed(item.id);
		await db.item.updateFailed(item.id);
		await db.account.updateFailed(account.id);
		assert.equal((await row('items', item.id)).failedCount, 2);
		assert.equal((await row('accounts', account.id)).failedCount, 1);

		await db.item.updateFailed(item.id, true);
		assert.equal((await row('items', item.id)).failedCount, 0);

		await db.item.updateBusy(item.id, true);
		await db.account.updateBusy(account.id, true);
		assert.equal((await row('items', item.id)).isBusy, 1);
		assert.equal((await row('accounts', account.id)).isBusy, 1);

		await db.item.resetAllBusy();
		await db.account.resetAllBusy();
		assert.equal(await count('items') > 0, true);
		assert.deepEqual(await query('SELECT COUNT(*) AS n FROM items WHERE isBusy = 1'), [{ n: 0 }]);
		assert.deepEqual(await query('SELECT COUNT(*) AS n FROM accounts WHERE isBusy = 1'), [{ n: 0 }]);
	});
});

describe('saveItemPageData', () => {
	const albumUrl = 'https://save.bandcamp.com/album/the-album';
	const trackUrls = ['https://save.bandcamp.com/track/one', 'https://save.bandcamp.com/track/two'];
	const fans = ['https://bandcamp.com/save-fan-1', 'https://bandcamp.com/save-fan-2'];

	const albumData = (): ItemPageData => ({
		url: albumUrl,
		accounts: { data: fans },
		tags: { data: ['Save-Techno', 'save-house'] },
		releaseDate: { data: new Date(2024, 2, 1) },
		album: { data: null },
		tracks: { data: trackUrls },
		imageUrl: { data: 'https://f4.bcbits.com/img/save.jpg' },
		errors: [],
	});

	it('saves an album page and counts what is new', async () => {
		const { entity: album } = await db.item.insert(albumUrl);

		const first = await saveItemPageData(album.id, albumData(), db);

		assert.deepEqual(first, {
			accounts: { total: 2, newRecords: 2, newRelations: 2 },
			tags: { total: 2, newRecords: 2, newRelations: 2 },
			releaseDate: { total: 1, newRecords: 1, newRelations: 1 },
			album: { total: 0, newRecords: 0, newRelations: 0 },
			tracks: { total: 2, newRecords: 2, newRelations: 2 },
			newUrls: [...fans, ...trackUrls],
		});

		const row = await itemByUrl(albumUrl);
		assert.equal(row.releaseDate, '2024-03-01');
		assert.equal(row.imageUrl, 'https://f4.bcbits.com/img/save.jpg');
		assert.ok(row.lastProcessingDate !== null);
		for (const url of trackUrls) {
			assert.equal((await itemByUrl(url)).albumId, album.id);
		}
		assert.deepEqual(
			await query('SELECT t.name FROM "items-to-tags" it JOIN tags t ON t.id = it.tagId WHERE it.itemId = ? ORDER BY t.name', [album.id]),
			[{ name: 'save-house' }, { name: 'save-techno' }],
		);
		assert.deepEqual(
			await query('SELECT a.url, ia.wishlist FROM "items-to-accounts" ia JOIN accounts a ON a.id = ia.accountId WHERE ia.itemId = ? ORDER BY a.url', [album.id]),
			fans.map(url => ({ url, wishlist: 0 })),
		);
	});

	it('finds nothing new when the same page is saved again', async () => {
		const { entity: album } = await db.item.insert(albumUrl);

		const second = await saveItemPageData(album.id, albumData(), db);

		assert.deepEqual(second, {
			accounts: { total: 2, newRecords: 0, newRelations: 0 },
			tags: { total: 2, newRecords: 0, newRelations: 0 },
			releaseDate: { total: 1, newRecords: 0, newRelations: 0 },
			album: { total: 0, newRecords: 0, newRelations: 0 },
			tracks: { total: 2, newRecords: 0, newRelations: 0 },
			newUrls: [],
		});
	});

	it('links a track to its album and skips empty fields', async () => {
		const trackUrl = 'https://save.bandcamp.com/track/single';
		const albumOfTrack = 'https://save.bandcamp.com/album/of-single';
		const { entity: track } = await db.item.insert(trackUrl);

		const stat = await saveItemPageData(track.id, {
			url: trackUrl,
			accounts: { data: null, error: new Error('x') },
			tags: { data: [] },
			releaseDate: { data: null },
			album: { data: albumOfTrack },
			tracks: { data: null },
			imageUrl: { data: null },
			errors: [],
		}, db);

		assert.deepEqual(stat, {
			accounts: { total: 0, newRecords: 0, newRelations: 0 },
			tags: { total: 0, newRecords: 0, newRelations: 0 },
			releaseDate: { total: 0, newRecords: 0, newRelations: 0 },
			album: { total: 1, newRecords: 1, newRelations: 1 },
			tracks: { total: 0, newRecords: 0, newRelations: 0 },
			newUrls: [albumOfTrack],
		});

		const row = await itemByUrl(trackUrl);
		assert.equal(row.albumId, (await itemByUrl(albumOfTrack)).id);
		assert.equal(row.imageUrl, null);
		assert.ok(row.lastProcessingDate !== null);
	});
});

describe('saveAccountPageData', () => {
	const items = ['https://acc.bandcamp.com/album/one', 'https://acc.bandcamp.com/track/two'];
	const follower = 'https://bandcamp.com/acc-follower';
	const followed = 'https://bandcamp.com/acc-followed';

	const pageData = (url: string): AccountPageData => ({
		url,
		collection: { total: 3, urls: items },
		wishlist: { total: 1, urls: [items[1]] },
		followers: { total: 1, urls: [follower] },
		following: { total: 2, urls: [followed] },
		errors: [],
	});

	it('saves all tabs and counts what is new', async () => {
		const url = 'https://bandcamp.com/acc-owner';
		const { entity: account } = await db.account.insert(url);

		const first = await saveAccountPageData(account.id, pageData(url), db);

		assert.deepEqual(first, {
			collection: { total: 3, allScraped: false, newRecords: 2, newRelations: 2, newUrls: items },
			wishlist: { total: 1, allScraped: true, newRecords: 0, newRelations: 0, newUrls: [] },
			followers: { total: 1, allScraped: true, newRecords: 1, newRelations: 1, newUrls: [follower] },
			following: { total: 2, allScraped: false, newRecords: 1, newRelations: 1, newUrls: [followed] },
		});

		assert.deepEqual(
			await query('SELECT i.url, ia.wishlist FROM "items-to-accounts" ia JOIN items i ON i.id = ia.itemId WHERE ia.accountId = ? ORDER BY i.url', [account.id]),
			[{ url: items[0], wishlist: 0 }, { url: items[1], wishlist: 1 }],
			'an item in both tabs ends up as wishlist',
		);

		const followerId = (await query('SELECT id FROM accounts WHERE url = ?', [follower]))[0].id;
		const followedId = (await query('SELECT id FROM accounts WHERE url = ?', [followed]))[0].id;
		assert.deepEqual(
			await query('SELECT followerId, followedId FROM followers WHERE followerId = ? OR followedId = ? ORDER BY followerId', [account.id, account.id]),
			[
				{ followerId: account.id, followedId },
				{ followerId, followedId: account.id },
			].sort((a, b) => a.followerId - b.followerId),
		);

		const row = (await query('SELECT lastProcessingDate FROM accounts WHERE id = ?', [account.id]))[0];
		assert.ok(row.lastProcessingDate !== null);
	});

	it('finds nothing new when the same page is saved again', async () => {
		const url = 'https://bandcamp.com/acc-owner';
		const { entity: account } = await db.account.insert(url);

		const second = await saveAccountPageData(account.id, pageData(url), db);

		assert.deepEqual(second, {
			collection: { total: 3, allScraped: false, newRecords: 0, newRelations: 0, newUrls: [] },
			wishlist: { total: 1, allScraped: true, newRecords: 0, newRelations: 0, newUrls: [] },
			followers: { total: 1, allScraped: true, newRecords: 0, newRelations: 0, newUrls: [] },
			following: { total: 2, allScraped: false, newRecords: 0, newRelations: 0, newUrls: [] },
		});
	});
});
