import 'reflect-metadata';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { AccountPageData, CrawlStore, CrawlTask, ItemPageData, UrlType } from '@band-spider/core';
import { LocalCrawlStore } from '../local-crawl-store';
import { BandDatabase } from '../db';

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

describe('LocalCrawlStore serial writes', () => {
	const empty = { total: 0, urls: [] as string[], complete: true };

	it('saves many pages at the same time without mixing their transactions', async () => {
		await clean();
		const accountUrls = Array.from({ length: 6 }, (_, i) => `https://serial-${i}.bandcamp.com`);
		for (const url of accountUrls) {
			await db.account.insert(url);
		}
		const tasks = await store.claim(UrlType.Account, 6, false);
		assert.equal(tasks.length, 6);

		const albumOf = (url: string) => `${url}/album/one`;
		const data = (url: string): AccountPageData => ({
			url,
			collection: { total: 1, urls: [albumOf(url)], complete: true },
			wishlist: empty,
			followers: empty,
			following: empty,
			errors: [],
		});

		// one save fails inside its transaction: it must not take the saves around it down
		const broken = { ...data(tasks[2].url), wishlist: null } as unknown as AccountPageData;
		const results = await Promise.allSettled(tasks.map((task, i) => store.saveAccount(task, i === 2 ? broken : data(task.url))));

		assert.deepEqual(results.map(r => r.status), ['fulfilled', 'fulfilled', 'rejected', 'fulfilled', 'fulfilled', 'fulfilled']);
		for (const [i, task] of tasks.entries()) {
			const albums = await db.query('SELECT COUNT(*) AS n FROM items WHERE url = ?', [albumOf(task.url)]);
			assert.equal(albums[0].n, i === 2 ? 0 : 1, task.url);
			// the failed task is still busy: the caller releases it
			assert.equal((await accountRow(task.url)).isBusy, i === 2 ? 1 : 0);
		}
	});

	it('saves items and accounts at the same time and keeps all data', async () => {
		await clean();
		const itemUrls = Array.from({ length: 4 }, (_, i) => `https://serial-items.bandcamp.com/track/t${i}`);
		const accountUrl = 'https://bandcamp.com/serial-account';
		for (const url of itemUrls) {
			await db.item.insert(url);
		}
		await db.account.insert(accountUrl);
		const items = await store.claim(UrlType.Item, 4, false);
		const [account] = await store.claim(UrlType.Account, 1, false);
		assert.equal(items.length, 4);
		assert.ok(account);

		const saves: Promise<unknown>[] = items.map(task => store.saveItem(task, {
			url: task.url,
			accounts: { data: [`https://bandcamp.com/fan-of-${task.id}`] },
			tags: { data: [`serial-tag-${task.id}`] },
			releaseDate: { data: new Date(2024, 2, 1) },
			album: { data: null },
			tracks: { data: [] },
			imageUrl: { data: 'https://f4.bcbits.com/img/serial.jpg' },
			errors: [],
		}));
		saves.push(store.saveAccount(account, {
			url: accountUrl,
			collection: { total: 1, urls: ['https://serial-account.bandcamp.com/album/one'], complete: true },
			wishlist: empty,
			followers: empty,
			following: empty,
			errors: [],
		}));
		await Promise.all(saves);

		for (const url of itemUrls) {
			assert.deepEqual(await itemRow(url), { processed: 1, failedCount: 0, isBusy: 0 });
		}
		assert.equal((await db.query('SELECT COUNT(*) AS n FROM accounts WHERE url LIKE ?', ['https://bandcamp.com/fan-of-%']))[0].n, 4);
		assert.equal((await db.query('SELECT COUNT(*) AS n FROM tags WHERE name LIKE ?', ['serial-tag-%']))[0].n, 4);
		assert.deepEqual(await accountRow(accountUrl), { processed: 1, failedCount: 0, isBusy: 0 });
	});

	it('a release during a failing save is not rolled back with it', async () => {
		await clean();
		const failingUrl = 'https://serial-roll.bandcamp.com';
		const otherUrl = 'https://serial-roll.bandcamp.com/track/other';
		await db.account.insert(failingUrl);
		await db.item.insert(otherUrl);
		const [account] = await store.claim(UrlType.Account, 1, false);
		const [item] = await store.claim(UrlType.Item, 1, false);
		const broken = { url: failingUrl, collection: empty, wishlist: null, followers: empty, following: empty, errors: [] } as unknown as AccountPageData;

		const save = store.saveAccount(account, broken);
		const release = store.release(item, 'failed');
		await assert.rejects(save);
		await release;

		assert.deepEqual(await itemRow(otherUrl), { processed: 0, failedCount: 1, isBusy: 0 });
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

describe('LocalCrawlStore candidates', () => {
	/** Counts the DB reads of not processed items. */
	const countReads = () => {
		const original = db.item.getNotProcessed.bind(db.item);
		const counter = { reads: 0, restore: () => { db.item.getNotProcessed = original; } };
		db.item.getNotProcessed = async (newestFirst?: boolean) => {
			counter.reads++;
			return original(newestFirst);
		};
		return counter;
	};

	it('reads the DB once for many claims', async () => {
		await clean();
		for (let n = 0; n < 5; n++) {
			await db.item.insert(`https://batch.bandcamp.com/track/${n}`);
		}
		const counter = countReads();
		try {
			const urls: string[] = [];
			for (let n = 0; n < 5; n++) {
				urls.push((await claimed(UrlType.Item)).url);
			}

			assert.equal(counter.reads, 1);
			assert.equal(new Set(urls).size, 5);
		} finally {
			counter.restore();
		}
	});

	it('reads the DB again when the candidates are used up', async () => {
		await clean();
		await db.item.insert('https://refill.bandcamp.com/track/first');
		await claimed(UrlType.Item);

		const late = 'https://refill.bandcamp.com/track/late';
		await db.item.insert(late);

		assert.equal((await claimed(UrlType.Item)).url, late);
	});

	it('a rate limited URL comes back after the candidates are used up', async () => {
		await clean();
		const url = 'https://refill.bandcamp.com/track/limited-again';
		await db.item.insert(url);
		await store.release(await claimed(UrlType.Item), 'rateLimited');

		assert.equal((await claimed(UrlType.Item)).url, url);
	});

	it('never hands out the same URL in both orders', async () => {
		await clean();
		for (let n = 0; n < 4; n++) {
			await db.item.insert(`https://order.bandcamp.com/track/${n}`);
		}

		const urls: string[] = [];
		for (let n = 0; n < 4; n++) {
			urls.push((await claimed(UrlType.Item, n % 2 === 1)).url);
		}

		assert.equal(new Set(urls).size, 4);
		assert.deepEqual(await store.claim(UrlType.Item, 1, false), []);
		assert.deepEqual(await store.claim(UrlType.Item, 1, true), []);
	});
});
