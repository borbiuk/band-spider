import { BandDatabase } from '../db';
import { AccountPageData, AccountPageStatistic, AccountTabData, AccountTabStatistic } from '@band-spider/core';

export async function saveAccountPageData(
	accountId: number,
	data: AccountPageData,
	database: BandDatabase
): Promise<AccountPageStatistic> {
	// One transaction per account page: one commit instead of one per row.
	return await database.transaction(async (transaction) => {
		const collection = await saveAccountItems(accountId, data.collection, false, transaction);
		const wishlist = await saveAccountItems(accountId, data.wishlist, true, transaction);

		const followers = await saveFollowTab(accountId, data.followers, true, transaction);
		const following = await saveFollowTab(accountId, data.following, false, transaction);

		// Save that account was processed now
		await transaction.account.updateProcessingDate(accountId);

		// A tab read to its end (or to its mark) starts the next read: keep a URL of its newest batch.
		// The marks of tabs that were not read to their end stay as they were.
		await transaction.account.updateScanMarks(accountId, {
			collection: scanMark(data.collection),
			wishlist: scanMark(data.wishlist),
			followers: scanMark(data.followers),
			following: scanMark(data.following),
		});

		return {
			collection,
			wishlist,
			followers,
			following,
		}
	});
}

/**
 * Saves the items of a collection or wishlist tab with batched queries.
 * Gives the same statistic as `readAndSaveAccountData` with `item.insert` and `account.addItem`.
 */
async function saveAccountItems(
	accountId: number,
	pageReadResult: AccountTabData,
	wishlist: boolean,
	database: BandDatabase
): Promise<AccountTabStatistic> {
	let newUrls: string[] = [];
	let newRelationsCount: number = 0;

	if (pageReadResult.urls.length !== 0) {
		const inserted = await database.item.insertMany(pageReadResult.urls);
		newUrls = inserted.newUrls;
		const ids = inserted.ids;
		newRelationsCount = await database.account.addItems(accountId, ids, wishlist);
	}

	return {
		total: pageReadResult.total,
		allScraped: pageReadResult.total === pageReadResult.urls.length,
		newRecords: newUrls.length,
		newRelations: newRelationsCount,
		newUrls,
	};
}

/**
 * Saves a followers or following tab with batched queries. The tab is of this account: `followers` are accounts
 * that follow it, the others are accounts it follows.
 */
async function saveFollowTab(
	accountId: number,
	pageReadResult: AccountTabData,
	followers: boolean,
	database: BandDatabase
): Promise<AccountTabStatistic> {
	let newUrls: string[] = [];
	let newRelationsCount: number = 0;

	if (pageReadResult.urls.length !== 0) {
		const inserted = await database.account.insertMany(pageReadResult.urls);
		newUrls = inserted.newUrls;
		newRelationsCount = await database.account.addFollowers(inserted.ids.map(id =>
			followers ? { followerId: id, followedId: accountId } : { followerId: accountId, followedId: id }));
	}

	return {
		total: pageReadResult.total,
		allScraped: pageReadResult.total === pageReadResult.urls.length,
		newRecords: newUrls.length,
		newRelations: newRelationsCount,
		newUrls,
	};
}

/** The mark of a tab after this read: its first URL (from the newest batch), null when empty. */
function scanMark(tab: AccountTabData): string | null | undefined {
	if (!tab.complete) {
		return undefined;
	}
	return tab.urls[0] ?? null;
}
