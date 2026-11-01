import { FindOptionsWhere, ObjectLiteral, Repository } from 'typeorm';
import { isNullOrUndefined } from '@band-spider/core';
import { InsertResult } from '../models/insert-result';

/**
 * Inserts a row that is unique by `key`, or returns the row that already exists.
 *
 * Another writer may insert the same row between the lookup and the insert. The insert then fails
 * on the unique key, and the row is looked up again.
 *
 * @param key - The unique column and its value. It is also the whole inserted row.
 * @param created - Builds the returned entity from the columns the insert generated.
 */
export async function insertUnique<T extends ObjectLiteral>(
	repository: Repository<T>,
	key: FindOptionsWhere<T> & Partial<T>,
	created: (generated: ObjectLiteral) => T,
): Promise<InsertResult<T>> {
	let existingRecord = await repository.findOne({ where: key });
	if (!isNullOrUndefined(existingRecord)) {
		return { entity: existingRecord, isInserted: false };
	}

	try {
		const insertResult = await repository.insert(key);
		return { entity: created(insertResult.generatedMaps[0]), isInserted: true };
	} catch (error) {
		existingRecord = await repository.findOne({ where: key });
		if (!isNullOrUndefined(existingRecord)) {
			return { entity: existingRecord, isInserted: false };
		}
		throw error;
	}
}

export interface InsertRelationOptions<T> {
	/** The row to insert. Defaults to `key`. */
	row?: Partial<T>;
	/** Called with the row that already exists, before `false` is returned. */
	onExisting?: (existingRecord: T) => Promise<void>;
	/** What to return when another writer inserted the same row after the lookup. */
	lostRace: boolean;
}

/**
 * Inserts a relation row unless it already exists.
 *
 * @param key - The columns of the primary key and their values.
 * @returns true when the row was inserted, false when it existed; `lostRace` when another writer
 * inserted it between the lookup and the insert.
 */
export async function insertRelation<T extends ObjectLiteral>(
	repository: Repository<T>,
	key: FindOptionsWhere<T> & Partial<T>,
	{ row = key, onExisting, lostRace }: InsertRelationOptions<T>,
): Promise<boolean> {
	let existingRecord = await repository.findOne({ where: key });
	if (!isNullOrUndefined(existingRecord)) {
		await onExisting?.(existingRecord);
		return false;
	}

	try {
		await repository.insert(row);
		return true;
	} catch (error) {
		existingRecord = await repository.findOne({ where: key });
		if (!isNullOrUndefined(existingRecord)) {
			return lostRace;
		}
		throw error;
	}
}
