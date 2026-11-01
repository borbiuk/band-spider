import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ServiceStats } from '../stats';

const tab = (total: number, newRecords: number, newRelations: number) => ({ total, newRecords, newRelations });

describe('ServiceStats flow', () => {
	it('adds the statistic of every saved page', () => {
		const stats = new ServiceStats();
		stats.onAccountSaved(3, {
			collection: { ...tab(10, 4, 5), allScraped: true, newUrls: [] },
			wishlist: { ...tab(6, 1, 2), allScraped: true, newUrls: [] },
			followers: { ...tab(2, 1, 1), allScraped: true, newUrls: [] },
			following: { ...tab(0, 0, 0), allScraped: true, newUrls: [] },
		});
		stats.onAccountSaved(0, {
			collection: { ...tab(5, 0, 1), allScraped: true, newUrls: [] },
			wishlist: { ...tab(0, 0, 0), allScraped: true, newUrls: [] },
			followers: { ...tab(0, 0, 0), allScraped: true, newUrls: [] },
			following: { ...tab(0, 0, 0), allScraped: true, newUrls: [] },
		});
		stats.onItemSaved(1, {
			accounts: tab(8, 2, 8), tags: tab(4, 0, 4), releaseDate: tab(0, 0, 0), album: tab(1, 1, 1), tracks: tab(0, 0, 0), newUrls: [],
		});

		const { flow } = stats.snapshot();
		assert.equal(flow?.accountPages.saved, 2);
		assert.deepEqual(flow?.accountPages.collection, tab(15, 4, 6));
		assert.deepEqual(flow?.accountPages.wishlist, tab(6, 1, 2));
		assert.equal(flow?.itemPages.saved, 1);
		assert.deepEqual(flow?.itemPages.accounts, tab(8, 2, 8));
		assert.deepEqual(flow?.itemPages.album, tab(1, 1, 1));
	});

	it('counts a save without a statistic as a page', () => {
		const stats = new ServiceStats();
		stats.onItemSaved(2);
		assert.equal(stats.snapshot().flow?.itemPages.saved, 1);
		assert.equal(stats.snapshot().newUrls, 2);
	});

	it('gives a copy, so a caller cannot change the counters', () => {
		const stats = new ServiceStats();
		const first = stats.snapshot();
		first.flow!.itemPages.saved = 99;
		assert.equal(stats.snapshot().flow?.itemPages.saved, 0);
	});
});
