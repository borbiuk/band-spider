import { EntityManager } from 'typeorm';
import { BandDatabase } from '../../../data/db';
import { InsertResult } from '../../../models/insert-result';
import { AccountPageData } from '../models/account-page-data';
import { AccountPageStatistic } from '../models/account-page-statistic';
import { AccountTabData } from '../models/account-tab-data';
import { AccountTabStatistic } from '../models/account-tab-statistic';

export async function saveAccountPageData(
	accountId: number,
	data: AccountPageData,
	database: BandDatabase
): Promise<AccountPageStatistic> {
	// One transaction per account page: one commit instead of one per row.
	return await database.dataSource.transaction(async (manager) => {
		const collection = await saveAccountItems(accountId, data.collection, false, database, manager);
		const wishlist = await saveAccountItems(accountId, data.wishlist, true, database, manager);

		const followers = await readAndSaveAccountData(
			accountId,
			data.followers,
			(accountUrl: string) => database.account.insert(accountUrl),
			(accountId, entityId) => database.account.addFollower(accountId, entityId)
		);

		const following = await readAndSaveAccountData(
			accountId,
			data.following,
			(accountUrl: string) => database.account.insert(accountUrl),
			(accountId, entityId) => database.account.addFollower(entityId, accountId)
		);

		// Save that account was processed now
		await database.account.updateProcessingDate(accountId);

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
	database: BandDatabase,
	manager: EntityManager
): Promise<AccountTabStatistic> {
	let newCount: number = 0;
	let newRelationsCount: number = 0;

	if (pageReadResult.urls.length !== 0) {
		const { ids, newUrls } = await database.item.insertMany(pageReadResult.urls, manager);
		newCount = newUrls.length;
		newRelationsCount = await database.account.addItems(accountId, ids, wishlist, manager);
	}

	return {
		total: pageReadResult.total,
		allScraped: pageReadResult.total === pageReadResult.urls.length,
		newRecords: newCount,
		newRelations: newRelationsCount,
	};
}

/**
 * Generic method to read data from a tab and save it in the database.
 *
 * @param accountId - Account ID.
 * @param pageReadResult - Account data scraped from the page.
 * @param insertFn - The method to save new data (either add item or add account).
 * @param saveRelationFn - The method to save relation between entities (link item or follower to account).
 * @returns An object containing the total and new counts of items or followers.
 */
async function readAndSaveAccountData(
	accountId: number,
	pageReadResult: AccountTabData,
	insertFn: (url: string) => Promise<InsertResult<{ id: number }>>,
	saveRelationFn: (accountId: number, entityId: number) => Promise<boolean>
): Promise<AccountTabStatistic> {
	const entityIds: number[] = [];

	let newCount: number = 0;
	let newRelationsCount: number = 0;

	// save new URLs
	for (const entityUrl of pageReadResult.urls) {
		const { entity: { id }, isInserted } = await insertFn(entityUrl);
		entityIds.push(id);

		if (isInserted) {
			newCount++;
		}
	}

	// save relations
	for (const entityId of entityIds) {
		const isRelationSaved = await saveRelationFn(accountId, entityId);
		if (isRelationSaved) {
			newRelationsCount++;
		}
	}

	return {
		total: pageReadResult.total,
		allScraped: pageReadResult.total === pageReadResult.urls.length,
		newRecords: newCount,
		newRelations: newRelationsCount,
	};
}

