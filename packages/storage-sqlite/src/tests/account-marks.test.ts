import 'reflect-metadata';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { CrawlTask, FetchPageReader, HttpClient, processAccount, RateLimitGate, UrlType } from '@band-spider/core';
import { LocalCrawlStore } from '../local-crawl-store';
import { BandDatabase } from '../db';

const tempDir: string = fs.mkdtempSync(path.join(os.tmpdir(), 'band-spider-marks-'));
let db: BandDatabase;

before(async () => {
	db = await BandDatabase.open({ file: path.join(tempDir, 'marks.sqlite'), synchronize: true });
});

after(async () => {
	await db.close();
	fs.rmSync(tempDir, { recursive: true, force: true });
});

const fanUrl = 'https://bandcamp.com/marks-fan';
const album = (name: string) => `https://x.bandcamp.com/album/${name}`;

/**
 * A fake Bandcamp for one fan whose collection is `collection`, newest first: the page carries the
 * first 2 records, the API serves the rest in pages of 2. Counts the API requests.
 */
const fakeBandcamp = (collection: string[]) => {
	const apiCalls: string[] = [];
	const blob = {
		fan_data: { fan_id: 1 },
		collection_data: { item_count: collection.length, last_token: 'p0' },
		wishlist_data: { item_count: 0 },
		followers_data: { item_count: 0 },
		following_fans_data: { item_count: 0 },
		item_cache: { collection: Object.fromEntries(collection.slice(0, 2).map((url, i) => [`a${i}`, { item_url: url }])) },
	};
	const html = `<div id="pagedata" data-blob="${JSON.stringify(blob).replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"></div>`;

	const fetchFn = (async (_input: string | URL | Request, init?: RequestInit) => {
		if (init?.method !== 'POST') {
			return new Response(html, { status: 200 });
		}
		const { older_than_token } = JSON.parse(String(init.body));
		apiCalls.push(older_than_token);
		const page = Number(older_than_token.slice(1));
		const records = collection.slice(2 + 2 * page, 4 + 2 * page);
		return new Response(JSON.stringify({
			items: records.map(item_url => ({ item_url })),
			more_available: 4 + 2 * page < collection.length,
			last_token: `p${page + 1}`,
		}), { status: 200 });
	}) as typeof fetch;

	const http = new HttpClient(new RateLimitGate({ sleep: async () => { } }), { fetchFn, minDelayMs: 0, maxDelayMs: 0 });
	return { reader: new FetchPageReader(http), apiCalls };
};

const linkedItems = async (accountId: number): Promise<string[]> =>
	(await db.query('SELECT i.url FROM "items-to-accounts" ia JOIN items i ON i.id = ia.itemId WHERE ia.accountId = ? ORDER BY i.url', [accountId]))
		.map(x => x.url);

describe('reading an account again', () => {
	it('reads only up to the newest records of the last complete read', async () => {
		const { entity: account } = await db.account.insert(fanUrl);
		const store = new LocalCrawlStore(db);
		// the claim reads the marks, so every read starts from the saved ones
		const claim = async (): Promise<CrawlTask> => {
			// the account is a candidate again
			await db.query('UPDATE accounts SET lastProcessingDate = NULL');
			const [task] = await store.claim(UrlType.Account, 1, false);
			assert.equal(task.url, fanUrl);
			return task;
		};
		const old = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(album);

		// first read: no marks, the whole collection
		const first = fakeBandcamp(old);
		assert.equal(await processAccount(await claim(), store, first.reader, 0), true);
		assert.equal(first.apiCalls.length, 3);
		assert.deepEqual(await linkedItems(account.id), [...old].sort());
		assert.equal((await db.account.getScanMarks(account.id)).collection, album('a'));

		// two new purchases; one of them is linked already, as an item page's supporter would do it
		const { ids: [linkedId] } = await db.item.insertMany([album('new-1')]);
		await db.account.addItem(account.id, linkedId);
		const current = [album('new-2'), album('new-1'), ...old];

		const second = fakeBandcamp(current);
		assert.equal(await processAccount(await claim(), store, second.reader, 0), true);

		assert.deepEqual(second.apiCalls, ['p0'], 'stops after the first API page, which holds the mark');
		assert.deepEqual(await linkedItems(account.id), [...current].sort(), 'both new items are linked');
		assert.equal((await db.account.getScanMarks(account.id)).collection, album('new-2'), 'the mark moves to the newest batch');
	});
});
