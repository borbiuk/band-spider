import 'reflect-metadata';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { saveAccountPageData } from '../account/account-db-client';
import { AccountPageData, ItemPageData } from '@band-spider/core';
import { saveItemPageData } from '../item/item-db-client';
import { BandDatabase } from '../db';

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
		assert.equal(await pragma('wal_autocheckpoint'), 10_000);
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

describe('a file with the old schema', () => {
	it('is not opened, also not with a schema sync', async () => {
		const file = path.join(tempDir, 'v1.sqlite');
		const Database = require('better-sqlite3');
		const old = new Database(file);
		old.exec(fs.readFileSync(path.join(__dirname, '../../src/tests/fixtures/schema-v1.sql'), 'utf8'));
		old.close();

		await assert.rejects(BandDatabase.open({ file, synchronize: true }), /schema before v2/);

		const check = new Database(file, { readonly: true });
		try {
			assert.equal(check.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'items_to_accounts'").get().n, 0, 'the sync did not run');
		} finally {
			check.close();
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

	it('account.insert and insertMany store the URL trimmed and in lower case', async () => {
		const { entity, isInserted } = await db.account.insert(' https://bandcamp.com/Case-Fan ');
		const many = await db.account.insertMany(['https://bandcamp.com/case-fan', 'https://bandcamp.com/CASE-FAN', 'https://bandcamp.com/Other-Fan']);

		assert.deepEqual([isInserted, entity.url], [true, 'https://bandcamp.com/case-fan']);
		assert.deepEqual(many.ids.slice(0, 2), [entity.id, entity.id]);
		assert.deepEqual(many.newUrls, ['https://bandcamp.com/other-fan']);
	});

	it('item.insert and insertMany trim the URL, keep its case and set the type', async () => {
		const { entity } = await db.item.insert(' https://type.bandcamp.com/album/Mixed ');
		const many = await db.item.insertMany(['https://type.bandcamp.com/album/Mixed', 'https://type.bandcamp.com/track/one']);
		const rows = await query("SELECT url, type FROM items WHERE url LIKE 'https://type.bandcamp.com/%' ORDER BY url");

		assert.equal(entity.url, 'https://type.bandcamp.com/album/Mixed');
		assert.equal(many.ids[0], entity.id);
		assert.deepEqual(rows.map(x => [x.url, x.type]), [
			['https://type.bandcamp.com/album/Mixed', 1],
			['https://type.bandcamp.com/track/one', 0],
		]);
	});

	it('item.insert and insertMany refuse a URL that is not a track or an album', async () => {
		await assert.rejects(db.item.insert('https://artist.bandcamp.com/'), /Not a track or album URL/);
		await assert.rejects(db.item.insertMany(['https://artist.bandcamp.comnull']), /Not a track or album URL/);
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
		const wishlist = async () => (await query('SELECT wishlist FROM items_to_accounts WHERE accountId = ? AND itemId = ?', [account.id, item.id]))[0].wishlist;

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

		const rows = await query('SELECT wishlist, COUNT(*) AS n FROM items_to_accounts WHERE accountId = ? GROUP BY wishlist', [account.id]);
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

describe('getNotProcessed order', () => {
	it('gives the newest rows first only when asked', async () => {
		const tracks = Array.from({ length: 5 }, (_, i) => `https://order.bandcamp.com/track/t${i}`);
		const fans = Array.from({ length: 5 }, (_, i) => `https://bandcamp.com/order-fan-${i}`);
		for (const url of tracks) await db.item.insert(url);
		for (const url of fans) await db.account.insert(url);

		const ids = (rows: { id: number, url: string }[], prefix: string) => rows.filter(x => x.url.startsWith(prefix)).map(x => x.id);
		const isAscending = (xs: number[]) => xs.every((x, i) => i === 0 || xs[i - 1] < x);
		const isDescending = (xs: number[]) => xs.every((x, i) => i === 0 || xs[i - 1] > x);

		const oldestItems = ids(await db.item.getNotProcessed(), 'https://order.bandcamp.com/');
		const newestItems = ids(await db.item.getNotProcessed(true), 'https://order.bandcamp.com/');
		const oldestAccounts = ids(await db.account.getNotProcessed(), 'https://bandcamp.com/order-fan-');
		const newestAccounts = ids(await db.account.getNotProcessed(true), 'https://bandcamp.com/order-fan-');

		assert.equal(oldestItems.length, 5);
		assert.ok(isAscending(oldestItems), 'default: lowest id first');
		assert.ok(isDescending(newestItems), 'newest first: highest id first');
		assert.deepEqual([...newestItems].reverse(), oldestItems);
		assert.ok(isAscending(oldestAccounts));
		assert.ok(isDescending(newestAccounts));
		assert.deepEqual([...newestAccounts].reverse(), oldestAccounts);
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
		assert.equal(row.releaseDate, Date.UTC(2024, 2, 1) / 86_400_000, 'days since 1970-01-01 of 2024-03-01');
		assert.equal(row.imageUrl, 'https://f4.bcbits.com/img/save.jpg');
		assert.ok(row.lastProcessingDate !== null);
		for (const url of trackUrls) {
			assert.equal((await itemByUrl(url)).albumId, album.id);
		}
		assert.deepEqual(
			await query('SELECT t.name FROM items_to_tags it JOIN tags t ON t.id = it.tagId WHERE it.itemId = ? ORDER BY t.name', [album.id]),
			[{ name: 'save-house' }, { name: 'save-techno' }],
		);
		assert.deepEqual(
			await query('SELECT a.url, ia.wishlist FROM items_to_accounts ia JOIN accounts a ON a.id = ia.accountId WHERE ia.itemId = ? ORDER BY a.url', [album.id]),
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

describe('scan marks', () => {
	it('are empty for an account that was never read', async () => {
		const { entity } = await db.account.insert('https://bandcamp.com/marks-new');
		assert.deepEqual(await db.account.getScanMarks(entity.id), {});
	});

	it('change only the tabs that are given', async () => {
		const { entity } = await db.account.insert('https://bandcamp.com/marks-update');

		await db.account.updateScanMarks(entity.id, { collection: 'https://x.bandcamp.com/album/a', wishlist: null });
		await db.account.updateScanMarks(entity.id, { collection: undefined, followers: 'https://bandcamp.com/f' });
		await db.account.updateScanMarks(entity.id, {});

		assert.deepEqual(await db.account.getScanMarks(entity.id), {
			collection: 'https://x.bandcamp.com/album/a',
			wishlist: null,
			followers: 'https://bandcamp.com/f',
			following: null,
		});
	});
});

describe('saveAccountPageData', () => {
	const items = ['https://acc.bandcamp.com/album/one', 'https://acc.bandcamp.com/track/two'];
	const follower = 'https://bandcamp.com/acc-follower';
	const followed = 'https://bandcamp.com/acc-followed';

	const pageData = (url: string): AccountPageData => ({
		url,
		// collection and following were not read to their end
		collection: { total: 3, urls: items, complete: false },
		wishlist: { total: 1, urls: [items[1]], complete: true },
		followers: { total: 1, urls: [follower], complete: true },
		following: { total: 2, urls: [followed], complete: false },
		errors: [],
	});

	it('skips a collection URL that is not a track or an album', async () => {
		const { entity: account } = await db.account.insert('https://bandcamp.com/acc-junk');
		const junk = ['https://junk.bandcamp.comnull', 'https://junk.bandcamp.com/subscribe'];
		const good = 'https://junk.bandcamp.com/album/kept';

		const stat = await saveAccountPageData(account.id, {
			url: 'https://bandcamp.com/acc-junk',
			collection: { total: 3, urls: [...junk, good], complete: true },
			wishlist: { total: 0, urls: [], complete: true },
			followers: { total: 0, urls: [], complete: true },
			following: { total: 0, urls: [], complete: true },
			errors: [],
		}, db);

		assert.deepEqual(stat.collection, { total: 3, allScraped: true, newRecords: 1, newRelations: 1, newUrls: [good] });
		assert.deepEqual(await query("SELECT url FROM items WHERE url LIKE 'https://junk.bandcamp.com%'"), [{ url: good }]);
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
			await query('SELECT i.url, ia.wishlist FROM items_to_accounts ia JOIN items i ON i.id = ia.itemId WHERE ia.accountId = ? ORDER BY i.url', [account.id]),
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

		assert.deepEqual(await db.account.getScanMarks(account.id), {
			collection: null,
			wishlist: items[1],
			followers: follower,
			following: null,
		}, 'only the tabs read to their end get a mark');
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

describe('batched saves', () => {
	const owner = 'https://bandcamp.com/batch-owner';
	const fan = (n: number) => `https://bandcamp.com/batch-fan-${n}`;

	const itemData = (url: string, accounts: string[], tags: string[]): ItemPageData => ({
		url,
		accounts: { data: accounts },
		tags: { data: tags },
		releaseDate: { data: null },
		album: { data: null },
		tracks: { data: null },
		imageUrl: { data: null },
		errors: [],
	} as unknown as ItemPageData);

	it('saves more supporters than one batch holds, and a second save finds nothing new', async () => {
		const url = 'https://batch.bandcamp.com/track/many';
		const { entity: item } = await db.item.insert(url);
		// a duplicate in the list is one account and one link
		const supporters = [...Array.from({ length: 1200 }, (_, i) => fan(i)), fan(0)];

		const first = await saveItemPageData(item.id, itemData(url, supporters, []), db);
		assert.equal(first.accounts.total, 1201);
		assert.equal(first.accounts.newRecords, 1200);
		assert.equal(first.accounts.newRelations, 1200);
		assert.equal(first.newUrls.length, 1200);
		assert.equal((await query('SELECT COUNT(*) AS n FROM items_to_accounts WHERE itemId = ?', [item.id]))[0].n, 1200);

		const second = await saveItemPageData(item.id, itemData(url, supporters, []), db);
		assert.deepEqual(second.accounts, { total: 1201, newRecords: 0, newRelations: 0 });
		assert.deepEqual(second.newUrls, []);
	});

	it('clears the wishlist flag of a link that now comes from the item page, without counting it as new', async () => {
		const url = 'https://batch.bandcamp.com/track/wishlist';
		const { entity: item } = await db.item.insert(url);
		const { entity: account } = await db.account.insert(fan(5000));
		await db.account.addItem(account.id, item.id, true);

		const stat = await saveItemPageData(item.id, itemData(url, [fan(5000)], []), db);

		assert.equal(stat.accounts.newRecords, 0);
		assert.equal(stat.accounts.newRelations, 0);
		const link = (await query('SELECT wishlist FROM items_to_accounts WHERE itemId = ? AND accountId = ?', [item.id, account.id]))[0];
		assert.equal(Boolean(link.wishlist), false);
	});

	it('lower-cases tags and counts a tag that comes twice once', async () => {
		const url = 'https://batch.bandcamp.com/track/tags';
		const { entity: item } = await db.item.insert(url);

		const stat = await saveItemPageData(item.id, itemData(url, [], ['Batch-Rock', 'batch-rock', 'Batch-Jazz']), db);

		assert.deepEqual(stat.tags, { total: 3, newRecords: 2, newRelations: 2 });
		assert.equal((await query('SELECT COUNT(*) AS n FROM tags WHERE name IN (?, ?)', ['batch-rock', 'batch-jazz']))[0].n, 2);
		assert.equal((await query('SELECT COUNT(*) AS n FROM items_to_tags WHERE itemId = ?', [item.id]))[0].n, 2);

		const again = await saveItemPageData(item.id, itemData(url, [], ['batch-rock', 'Batch-Jazz']), db);
		assert.deepEqual(again.tags, { total: 2, newRecords: 0, newRelations: 0 });
	});

	it('saves an item page in one transaction: a failure leaves nothing of the page', async () => {
		const url = 'https://batch.bandcamp.com/track/rollback';
		const { entity: item } = await db.item.insert(url);
		const accountsBefore = await count('accounts');
		const data = itemData(url, [fan(7001), fan(7002)], ['batch-rollback']);
		// a value SQLite cannot bind: the save fails at its last statements, after the accounts and tags were written
		data.imageUrl = { data: {} as unknown as string };

		await assert.rejects(saveItemPageData(item.id, data, db));

		assert.equal(await count('accounts'), accountsBefore);
		assert.equal((await query('SELECT COUNT(*) AS n FROM tags WHERE name = ?', ['batch-rollback']))[0].n, 0);
		assert.equal((await query('SELECT COUNT(*) AS n FROM items_to_accounts WHERE itemId = ?', [item.id]))[0].n, 0);
		assert.equal((await itemByUrl(url)).lastProcessingDate, null);
	});

	it('saves followers and following in the right direction and counts a repeated account once', async () => {
		const { entity: account } = await db.account.insert(owner);
		const data: AccountPageData = {
			url: owner,
			collection: { total: 0, urls: [], complete: true },
			wishlist: { total: 0, urls: [], complete: true },
			followers: { total: 3, urls: [fan(9001), fan(9002), fan(9001)], complete: true },
			following: { total: 1, urls: [fan(9003)], complete: true },
			errors: [],
		};

		const stat = await saveAccountPageData(account.id, data, db);

		assert.deepEqual(stat.followers, { total: 3, allScraped: true, newRecords: 2, newRelations: 2, newUrls: [fan(9001), fan(9002)] });
		assert.deepEqual(stat.following, { total: 1, allScraped: true, newRecords: 1, newRelations: 1, newUrls: [fan(9003)] });
		const id = async (url: string) => (await query('SELECT id FROM accounts WHERE url = ?', [url]))[0].id;
		const pairs = (await query('SELECT followerId, followedId FROM followers WHERE followerId = ? OR followedId = ? ORDER BY followerId, followedId', [account.id, account.id]))
			.map(x => `${x.followerId}>${x.followedId}`).sort();
		const expected = [`${await id(fan(9001))}>${account.id}`, `${await id(fan(9002))}>${account.id}`, `${account.id}>${await id(fan(9003))}`].sort();
		assert.deepEqual(pairs, expected);

		const again = await saveAccountPageData(account.id, data, db);
		assert.equal(again.followers.newRelations, 0);
		assert.equal(again.following.newRelations, 0);
		assert.deepEqual(again.followers.newUrls, []);
	});
});
