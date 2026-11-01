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

before(async () => {
	db = await BandDatabase.open({ file: path.join(tempDir, 'store.sqlite'), synchronize: true });
	store = new LocalCrawlStore(db);
});

after(async () => {
	await db.close();
	fs.rmSync(tempDir, { recursive: true, force: true });
});

const itemRow = async (url: string) =>
	(await db.query('SELECT lastProcessingDate IS NOT NULL AS processed, failedCount, isBusy FROM items WHERE url = ?', [url]))[0];
const accountRow = async (url: string) =>
	(await db.query('SELECT lastProcessingDate IS NOT NULL AS processed, failedCount, isBusy FROM accounts WHERE url = ?', [url]))[0];

const claimed = async (url: string): Promise<CrawlTask> => {
	const result = await store.claim(url);
	assert.equal(result.kind, 'claimed');
	return result.kind === 'claimed' ? result.task : null;
};

describe('LocalCrawlStore claim', () => {
	it('claims an item URL and marks it busy', async () => {
		const url = 'https://claim.bandcamp.com/track/one';
		const task = await claimed(url);

		assert.deepEqual(task, { id: task.id, url, type: UrlType.Item });
		assert.deepEqual(await itemRow(url), { processed: 0, failedCount: 0, isBusy: 1 });
	});

	it('claims an account URL with its scan marks', async () => {
		const url = 'https://bandcamp.com/claim-fan';
		const { entity } = await db.account.insert(url);
		await db.account.updateScanMarks(entity.id, { collection: 'https://claim.bandcamp.com/album/a', wishlist: null });

		const task = await claimed(url);

		assert.equal(task.type, UrlType.Account);
		assert.equal(task.id, entity.id);
		assert.equal(task.marks.collection, 'https://claim.bandcamp.com/album/a');
		assert.equal(task.marks.wishlist, null);
		assert.deepEqual(await accountRow(url), { processed: 0, failedCount: 0, isBusy: 1 });
	});

	it('answers busy for a URL that is claimed already', async () => {
		const url = 'https://claim.bandcamp.com/track/twice';
		await claimed(url);

		assert.deepEqual(await store.claim(url), { kind: 'busy' });
	});

	it('forgets a URL that is not an item or an account', async () => {
		const url = 'https://claim.bandcamp.com/';

		assert.deepEqual(await store.claim(url), { kind: 'invalid' });
		assert.equal((await db.query('SELECT COUNT(*) AS n FROM items WHERE url = ?', [url]))[0].n, 0);
	});
});

describe('LocalCrawlStore pending URLs and busy reset', () => {
	it('lists the URLs that were not processed and resets the busy flags', async () => {
		await db.query('UPDATE items SET lastProcessingDate = CURRENT_DATE WHERE lastProcessingDate IS NULL');
		const url = 'https://pending.bandcamp.com/track/one';
		await claimed(url);

		await store.resetBusy();

		assert.deepEqual((await itemRow(url)).isBusy, 0);
		assert.deepEqual(await store.pendingUrls(UrlType.Item, false), [url]);
	});
});

describe('LocalCrawlStore save', () => {
	it('saveItem saves the page, gives the statistic and releases the task', async () => {
		const url = 'https://save-store.bandcamp.com/album/the-album';
		const track = 'https://save-store.bandcamp.com/track/one';
		const task = await claimed(url);
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
		await db.account.insert(url);
		const task = await claimed(url);
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
		const url = 'https://release.bandcamp.com/track/failed';
		await store.release(await claimed(url), 'failed');

		assert.deepEqual(await itemRow(url), { processed: 0, failedCount: 1, isBusy: 0 });
	});

	it('notFound counts a failure and releases the task', async () => {
		const url = 'https://bandcamp.com/release-gone';
		await store.release(await claimed(url), 'notFound');

		assert.deepEqual(await accountRow(url), { processed: 0, failedCount: 1, isBusy: 0 });
	});

	it('rateLimited only releases the task', async () => {
		const url = 'https://release.bandcamp.com/track/limited';
		await store.release(await claimed(url), 'rateLimited');

		assert.deepEqual(await itemRow(url), { processed: 0, failedCount: 0, isBusy: 0 });
	});
});
