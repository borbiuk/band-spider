import {
	defaultItemTabStatistic,
	isNullOrUndefined,
	ItemPageData,
	ItemPageStatistic,
	ItemTabData,
	ItemTabStatistic,
} from '@band-spider/core';
import { BandDatabase } from '../db';

export async function saveItemPageData(
	itemId: number,
	data: ItemPageData,
	database: BandDatabase
): Promise<ItemPageStatistic> {

	const newUrls: string[] = [];

	const accounts = await saveAccountsData(
		itemId,
		data.accounts,
		database,
		newUrls,
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
		newUrls,
	);

	const tracks = await saveTracksData(
		itemId,
		data.tracks,
		database,
		newUrls,
	);

	await database.item.updateImageUrl(itemId, data.imageUrl.data);

	// Save that account was processed now
	await database.item.updateProcessingDate(itemId);

	return {
		accounts,
		tags,
		releaseDate,
		album,
		tracks,
		newUrls,
	}
}

async function saveAccountsData(
	itemId: number,
	{ data }: ItemTabData<string[]>,
	database: BandDatabase,
	newUrls: string[]
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
			newUrls.push(accountUrl);
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
	database: BandDatabase,
	newUrls: string[]
): Promise<ItemTabStatistic> {
	if (isNullOrUndefined(data)) {
		return defaultItemTabStatistic;
	}

	const { entity: { id }, isInserted } = await database.item.insert(data);
	if (isInserted) {
		newUrls.push(data);
	}
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
	database: BandDatabase,
	newUrls: string[]
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
			newUrls.push(track);
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
