import 'reflect-metadata';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { AccountPageData } from '../core/account/models/account-page-data';
import type { CrawlStore, CrawlTask } from '../core/crawl-store';
import type { ItemPageData } from '../core/item/models/item-page-data';
import { LocalCrawlStore } from '../core/local-crawl-store';
import { BandDatabase } from '../data/db';
import { UrlType } from '../models/url-type';

const tempDir: string = fs.mkdtempSync(path.join(os.tmpdir(), 'band-spider-store-'));
let db: BandDatabase;
let store: CrawlStore;

after(async () => {
	await db.close();
	fs.rmSync(tempDir, { recursive: true, force: true });
});

const itemRow = async (url: string) =>
	(await db.query('SELECT lastProcessingDate IS NOT NULL AS processed, failedCount, isBusy FROM items WHERE url = ?', [url]))[0];
const accountRow = async (url: string) =>
	(await db.query('SELECT lastProcessingDate IS NOT NULL AS processed, failedCount, isBusy FROM accounts WHERE url = ?', [url]))[0];

let clock = 0;

before(async () => {
	db = await BandDatabase.open({ file: path.join(tempDir, 'store.sqlite'), synchronize: true });
	// the lease is 1000 ms, the clock is set by the tests
	store = new LocalCrawlStore(db, 1000, () => clock);
});

/** Makes every row processed, so a test sees only the rows it inserts. */
const clean = async () => {
	await db.query('UPDATE items SET lastProcessingDate = CURRENT_DATE WHERE lastProcessingDate IS NULL');
	await db.query('UPDATE accounts SET lastProcessingDate = CURRENT_DATE WHERE lastProcessingDate IS NULL');
	await store.resetBusy();
};

const claimed = async (type: UrlType, newestFirst = false): Promise<CrawlTask> => {
	const [task] = await store.claim(type, 1, newestFirst);
	assert.ok(task, 'a task is expected');
	return task;
};

describe('LocalCrawlStore claim', () => {
	it('claims an item URL and marks it busy', async () => {
		await clean();
		const url = 'https://claim.bandcamp.com/track/one';
		await db.item.insert(url);

		const task = await claimed(UrlType.Item);

		assert.deepEqual(task, { id: task.id, url, type: UrlType.Item });
		assert.deepEqual(await itemRow(url), { processed: 0, failedCount: 0, isBusy: 1 });
	});

	it('claims only /track/ item URLs', async () => {
		await clean();
		await db.item.insert('https://claim.bandcamp.com/album/not-a-track');

		assert.deepEqual(await store.claim(UrlType.Item, 5, false), []);
	});

	it('claims an account URL with its scan marks', async () => {
		await clean();
		const url = 'https://bandcamp.com/claim-fan';
		const { entity } = await db.account.insert(url);
		await db.account.updateScanMarks(entity.id, { collection: 'https://claim.bandcamp.com/album/a', wishlist: null });

		const task = await claimed(UrlType.Account);

		assert.equal(task.type, UrlType.Account);
		assert.equal(task.url, url);
		assert.equal(task.id, entity.id);
		assert.equal(task.marks.collection, 'https://claim.bandcamp.com/album/a');
		assert.equal(task.marks.wishlist, null);
		assert.deepEqual(await accountRow(url), { processed: 0, failedCount: 0, isBusy: 1 });
	});

	it('hands out at most `count` URLs and keeps the rest', async () => {
		await clean();
		for (const n of [1, 2, 3]) {
			await db.item.insert(`https://count.bandcamp.com/track/t${n}`);
		}

		const first = await store.claim(UrlType.Item, 2, false);
		const second = await store.claim(UrlType.Item, 2, false);

		assert.deepEqual(first.map(x => x.url), ['https://count.bandcamp.com/track/t1', 'https://count.bandcamp.com/track/t2']);
		assert.deepEqual(second.map(x => x.url), ['https://count.bandcamp.com/track/t3']);
		assert.deepEqual(await store.claim(UrlType.Item, 2, false), []);
	});

	it('takes the newest URLs first when asked', async () => {
		await clean();
		for (const n of [1, 2, 3]) {
			await db.item.insert(`https://newest.bandcamp.com/track/t${n}`);
		}

		const [task] = await store.claim(UrlType.Item, 1, true);

		assert.equal(task.url, 'https://newest.bandcamp.com/track/t3');
	});

	it('never gives the same URL to two workers', async () => {
		await clean();
		for (let n = 0; n < 20; n++) {
			await db.item.insert(`https://workers.bandcamp.com/track/t${n}`);
		}

		// 5 workers claim at the same time, one URL per call
		const worker = async () => {
			const urls: string[] = [];
			for (let i = 0; i < 6; i++) {
				urls.push(...(await store.claim(UrlType.Item, 1, false)).map(x => x.url));
			}
			return urls;
		};
		const all = (await Promise.all(Array.from({ length: 5 }, worker))).flat();

		assert.equal(all.length, 20);
		assert.equal(new Set(all).size, 20);
	});
});

describe('LocalCrawlStore lease', () => {
	it('makes a URL claimable again when the lease is expired', async () => {
		await clean();
		clock = 10_000;
		const url = 'https://lease.bandcamp.com/track/one';
		await db.item.insert(url);
		const task = await claimed(UrlType.Item);

		clock = 10_999;
		assert.deepEqual(await store.claim(UrlType.Item, 1, false), [], 'the lease is still valid');

		clock = 11_000;
		const [again] = await store.claim(UrlType.Item, 1, false);
		assert.equal(again.id, task.id);
		assert.deepEqual(await itemRow(url), { processed: 0, failedCount: 0, isBusy: 1 });
	});

	it('extendLease moves the end of the lease', async () => {
		await clean();
		clock = 20_000;
		await db.item.insert('https://lease.bandcamp.com/track/long');
		const task = await claimed(UrlType.Item);

		clock = 20_900;
		assert.equal(await store.extendLease(task), true);

		clock = 21_500;
		assert.deepEqual(await store.claim(UrlType.Item, 1, false), [], 'extended until 21 900');
		clock = 21_900;
		assert.equal((await store.claim(UrlType.Item, 1, false)).length, 1);
	});

	it('extendLease is false for a task that was released', async () => {
		await clean();
		await db.item.insert('https://lease.bandcamp.com/track/released');
		const task = await claimed(UrlType.Item);
		await store.release(task, 'rateLimited');

		assert.equal(await store.extendLease(task), false);
	});

	it('resetBusy frees all URLs and forgets the leases', async () => {
		await clean();
		const url = 'https://lease.bandcamp.com/track/reset';
		await db.item.insert(url);
		const task = await claimed(UrlType.Item);

		await store.resetBusy();

		assert.equal((await itemRow(url)).isBusy, 0);
		assert.equal(await store.extendLease(task), false);
		assert.equal((await store.claim(UrlType.Item, 1, false)).length, 1);
	});
});

describe('LocalCrawlStore save', () => {
	it('saveItem saves the page, gives the statistic and releases the task', async () => {
		await clean();
		const url = 'https://save-store.bandcamp.com/track/the-track';
		const track = 'https://save-store.bandcamp.com/track/one';
		await db.item.insert(url);
		const task = await claimed(UrlType.Item);
		const data: ItemPageData = {
			url,
			accounts: { data: ['https://bandcamp.com/store-fan'] },
			tags: { data: ['store-tag'] },
			releaseDate: { data: new Date(2024, 2, 1) },
			album: { data: null },
			tracks: { data: [track] },
			imageUrl: { data: 'https://f4.bcbits.com/img/store.jpg' },
			errors: [],
		};

		const statistic = await store.saveItem(task, data);

		assert.deepEqual(statistic.accounts, { total: 1, newRecords: 1, newRelations: 1 });
		assert.deepEqual(statistic.tags, { total: 1, newRecords: 1, newRelations: 1 });
		assert.deepEqual(statistic.tracks, { total: 1, newRecords: 1, newRelations: 1 });
		assert.deepEqual(statistic.newUrls, ['https://bandcamp.com/store-fan', track]);
		assert.deepEqual(await itemRow(url), { processed: 1, failedCount: 0, isBusy: 0 });
	});

	it('saveAccount saves the page, gives the statistic and releases the task', async () => {
		const url = 'https://bandcamp.com/store-owner';
		await clean();
		await db.account.insert(url);
		const task = await claimed(UrlType.Account);
		const album = 'https://store-owner.bandcamp.com/album/one';
		const empty = { total: 0, urls: [] as string[], complete: true };
		const data: AccountPageData = {
			url,
			collection: { total: 1, urls: [album], complete: true },
			wishlist: empty,
			followers: empty,
			following: empty,
			errors: [],
		};

		const statistic = await store.saveAccount(task, data);

		assert.deepEqual(statistic.collection, { total: 1, allScraped: true, newRecords: 1, newRelations: 1, newUrls: [album] });
		assert.deepEqual(await accountRow(url), { processed: 1, failedCount: 0, isBusy: 0 });
		assert.equal((await db.account.getScanMarks(task.id)).collection, album);
	});
});

describe('LocalCrawlStore release', () => {
	it('failed counts a failure and releases the task', async () => {
		await clean();
		const url = 'https://release.bandcamp.com/track/failed';
		await db.item.insert(url);
		await store.release(await claimed(UrlType.Item), 'failed');

		assert.deepEqual(await itemRow(url), { processed: 0, failedCount: 1, isBusy: 0 });
	});

	it('notFound counts a failure and releases the task', async () => {
		await clean();
		const url = 'https://bandcamp.com/release-gone';
		await db.account.insert(url);
		await store.release(await claimed(UrlType.Account), 'notFound');

		assert.deepEqual(await accountRow(url), { processed: 0, failedCount: 1, isBusy: 0 });
	});

	it('rateLimited only releases the task', async () => {
		await clean();
		const url = 'https://release.bandcamp.com/track/limited';
		await db.item.insert(url);
		await store.release(await claimed(UrlType.Item), 'rateLimited');

		assert.deepEqual(await itemRow(url), { processed: 0, failedCount: 0, isBusy: 0 });
	});
});
