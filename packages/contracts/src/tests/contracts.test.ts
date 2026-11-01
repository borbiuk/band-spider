import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	type AccountPageDataDto,
	type ItemPageDataDto,
	accountPageDataSchema,
	accountPageStatisticSchema,
	claimRequestSchema,
	claimResponseSchema,
	errorResponseSchema,
	extendLeaseResponseSchema,
	healthResponseSchema,
	itemPageDataSchema,
	itemPageStatisticSchema,
	releaseRequestSchema,
	saveAccountRequestSchema,
	saveItemRequestSchema,
	statsResponseSchema,
} from '../index';

// what a real HTTP call does: stringify on one side, parse and validate on the other
const overJson = <T>(schema: { parse(value: unknown): T }, value: unknown): T =>
	schema.parse(JSON.parse(JSON.stringify(value)));

const itemData: ItemPageDataDto = {
	url: 'https://a.bandcamp.com/album/x',
	accounts: { data: ['https://b.bandcamp.com', 'https://c.bandcamp.com'] },
	tags: { data: ['rock', 'live'] },
	releaseDate: { data: new Date('2024-05-17T00:00:00.000Z') },
	album: { data: 'https://a.bandcamp.com/album/x' },
	tracks: { data: ['https://a.bandcamp.com/track/1'] },
	imageUrl: { data: 'https://f4.bcbits.com/img/a1.jpg' },
	errors: [],
};

const accountTab = { total: 2, urls: ['https://a.bandcamp.com/album/1'], complete: true, stoppedAtMark: false };

const accountData: AccountPageDataDto = {
	url: 'https://bandcamp.com/someone',
	collection: accountTab,
	wishlist: { total: 0, urls: [], complete: true },
	followers: { total: 5, urls: ['https://x.bandcamp.com'], complete: false, error: 'HTTP 500' },
	following: accountTab,
	errors: ['followers failed'],
};

const itemTabStatistic = { total: 3, newRecords: 1, newRelations: 2 };
const itemStatistic = {
	accounts: itemTabStatistic,
	tags: itemTabStatistic,
	releaseDate: itemTabStatistic,
	album: itemTabStatistic,
	tracks: itemTabStatistic,
	newUrls: ['https://new.bandcamp.com'],
};

const accountTabStatistic = { total: 4, allScraped: true, newRecords: 1, newRelations: 1, newUrls: ['u1', 'u2'] };
const accountStatistic = {
	collection: accountTabStatistic,
	wishlist: accountTabStatistic,
	followers: accountTabStatistic,
	following: accountTabStatistic,
};

describe('contracts', () => {
	it('keeps item page data over JSON, the date comes back as a Date', () => {
		const result = overJson(itemPageDataSchema, itemData);
		assert.ok(result.releaseDate.data instanceof Date);
		assert.deepEqual(result, itemData);
	});

	it('keeps a null release date and missing optional tabs', () => {
		const data: ItemPageDataDto = { ...itemData, releaseDate: { data: null }, album: undefined, tracks: undefined };
		const result = overJson(itemPageDataSchema, data);
		assert.equal(result.releaseDate.data, null);
		assert.equal(result.album, undefined);
	});

	it('keeps account page data over JSON', () => {
		assert.deepEqual(overJson(accountPageDataSchema, accountData), accountData);
	});

	it('keeps both statistics over JSON', () => {
		assert.deepEqual(overJson(itemPageStatisticSchema, itemStatistic), itemStatistic);
		assert.deepEqual(overJson(accountPageStatisticSchema, accountStatistic), accountStatistic);
	});

	it('keeps save requests with the task and its marks', () => {
		const task = { id: 7, url: 'https://bandcamp.com/someone', type: 'account' as const, marks: { collection: 'u', wishlist: null as string | null } };
		assert.deepEqual(overJson(saveAccountRequestSchema, { task, data: accountData }), { task, data: accountData });
		const itemTask = { id: 8, url: itemData.url, type: 'item' as const };
		assert.deepEqual(overJson(saveItemRequestSchema, { task: itemTask, data: itemData }), { task: itemTask, data: itemData });
	});

	it('checks claim and release bodies', () => {
		assert.deepEqual(overJson(claimRequestSchema, { type: 'item', count: 3, newestFirst: true }), { type: 'item', count: 3, newestFirst: true });
		assert.throws(() => claimRequestSchema.parse({ type: 'track', count: 1, newestFirst: false }));
		assert.throws(() => claimRequestSchema.parse({ type: 'item', count: 0, newestFirst: false }));
		const task = { id: 1, url: 'u', type: 'item' as const };
		assert.deepEqual(overJson(claimResponseSchema, { tasks: [task] }), { tasks: [task] });
		assert.deepEqual(overJson(releaseRequestSchema, { task, reason: 'failed' }), { task, reason: 'failed' });
		assert.throws(() => releaseRequestSchema.parse({ task, reason: 'other' }));
	});

	it('keeps health, lease, stats and error bodies', () => {
		assert.deepEqual(overJson(healthResponseSchema, { status: 'ok' }), { status: 'ok' });
		assert.deepEqual(overJson(extendLeaseResponseSchema, { extended: false }), { extended: false });
		assert.deepEqual(overJson(errorResponseSchema, { message: 'boom' }), { message: 'boom' });
		const stats = { startedAt: new Date('2026-01-02T03:04:05.000Z'), claimed: 1, itemsSaved: 2, accountsSaved: 3, released: 4, newUrls: 5 };
		const result = overJson(statsResponseSchema, stats);
		assert.ok(result.startedAt instanceof Date);
		assert.deepEqual(result, stats);
	});

	it('rejects page data with a wrong shape', () => {
		assert.throws(() => itemPageDataSchema.parse({ ...itemData, errors: [new Error('x')] }));
		assert.throws(() => accountPageDataSchema.parse({ ...accountData, collection: { total: 1 } }));
	});
});
