import { isNullOrUndefined } from '../../../common/utils';
import { BandDatabase } from '../../../data/db';
import { ItemPageData } from '../models/item-page-data';
import { ItemPageStatistic } from '../models/item-page-statistic';
import { ItemTabData } from '../models/item-tab-data';
import { defaultItemTabStatistic, ItemTabStatistic } from '../models/item-tab-statistic';

export async function saveItemPageData(
	itemId: number,
	data: ItemPageData,
	database: BandDatabase
): Promise<ItemPageStatistic> {

	const accounts = await saveAccountsData(
		itemId,
		data.accounts,
		database,
	);

	const tags = await saveTagsData(
		itemId,
		data.tags,
		database,
	);

	const releaseDate = await saveReleaseDateData(
		itemId,
		data.releaseDate,
		database,
	);

	const album = await saveAlbumData(
		itemId,
		data.album,
		database,
	);

	const tracks = await saveTracksData(
		itemId,
		data.tracks,
		database,
	);

	// Save that account was processed now
	await database.item.updateProcessingDate(itemId);

	return {
		accounts,
		tags,
		releaseDate,
		album,
		tracks
	}
}

async function saveAccountsData(
	itemId: number,
	{ data }: ItemTabData<string[]>,
	database: BandDatabase
): Promise<ItemTabStatistic> {
	if (isNullOrUndefined(data)) {
		return defaultItemTabStatistic;
	}

	let newAccountCount: number = 0;
	let newRelationsCount: number = 0;

	// save Accounts and relations
	for (const accountUrl of data) {
		const { entity: { id }, isInserted } = await database.account.insert(accountUrl);
		if (isInserted) {
			newAccountCount++;
		}

		const added = await database.account.addItem(id, itemId);
		if (added) {
			newRelationsCount++;
		}
	}

	return {
		total: data.length,
		newRecords: newAccountCount,
		newRelations: newRelationsCount,
	}
}

async function saveTagsData(
	itemId: number,
	{ data }: ItemTabData<string[]>,
	database: BandDatabase
): Promise<ItemTabStatistic> {
	if (isNullOrUndefined(data)) {
		return defaultItemTabStatistic;
	}

	let newTagsCount: number = 0;
	let newRelationsCount: number = 0;

	// save Tags and relations
	for (const tag of data) {
		const { entity: { id }, isInserted } = await database.tag.insert(tag);
		if (isInserted) {
			newTagsCount++;
		}

		const added = await database.tag.addItem(id, itemId);
		if (added) {
			newRelationsCount++;
		}
	}

	return {
		total: data.length,
		newRecords: newTagsCount,
		newRelations: newRelationsCount,
	}
}

async function saveReleaseDateData(
	itemId: number,
	{ data }: ItemTabData<Date>,
	database: BandDatabase
): Promise<ItemTabStatistic> {
	if (isNullOrUndefined(data)) {
		return defaultItemTabStatistic;
	}

	const isAlreadySaved = await database.item.updateReleaseDate(itemId, data);
	return {
		total: 1,
		newRecords: Number(isAlreadySaved),
		newRelations: Number(isAlreadySaved)
	};
}

async function saveAlbumData(
	trackId: number,
	{ data }: ItemTabData<string>,
	database: BandDatabase
): Promise<ItemTabStatistic> {
	if (isNullOrUndefined(data)) {
		return defaultItemTabStatistic;
	}

	const { entity: { id }, isInserted } = await database.item.insert(data);
	const added = await database.item.updateTrackAlbum(trackId, id);

	return {
		total: 1,
		newRecords: Number(isInserted),
		newRelations: Number(added)
	};
}

async function saveTracksData(
	albumId: number,
	{ data }: ItemTabData<string[]>,
	database: BandDatabase
): Promise<ItemTabStatistic> {
	if (isNullOrUndefined(data)) {
		return defaultItemTabStatistic;
	}

	let newTracksCount: number = 0;
	let newRelationsCount: number = 0;

	for (const track of data) {
		const { entity: { id }, isInserted } = await database.item.insert(track);
		if (isInserted) {
			newTracksCount++;
		}

		const added = await database.item.updateTrackAlbum(id, albumId);
		if (added) {
			newRelationsCount++;
		}
	}

	return {
		total: data.length,
		newRecords: newTracksCount,
		newRelations: newRelationsCount
	};
}
