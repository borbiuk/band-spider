import { EntityManager } from 'typeorm';
import { chunk } from '@band-spider/core';
import { InsertResult } from '../models/insert-result';
import { ItemToTagEntity } from '../entities/item-to-tag-entity';
import { TagEntity } from '../entities/tag-entity';
import { DB_BATCH_SIZE, insertRelation, insertUnique } from './insert-helpers';

export class TagRepository {
	constructor(
		private readonly manager: EntityManager
	) {
	}

	public async getAll(
		page: number = 1,
		pageSize: number = 10
	): Promise<TagEntity[]> {
		const repository = this.manager.getRepository(TagEntity);

		return await repository.find({
			skip: (page - 1) * pageSize,
			take: pageSize,
		});
	}

	public async insert(tag: string): Promise<InsertResult<TagEntity>> {
		tag = tag.toLowerCase();

		return await insertUnique(
			this.manager.getRepository(TagEntity),
			{ name: tag },
			generated => ({ ...(generated as TagEntity), name: tag }),
		);
	};

	/**
	 * Batch version of `insert` for many tags. A tag is lower-cased first, as `insert` does.
	 *
	 * @returns the ids of the distinct tags (the order is not set) and how many of those tags did not exist before.
	 */
	public async insertMany(tags: string[]): Promise<{ ids: number[], newCount: number }> {
		const idByName = new Map<string, number>();
		let newCount = 0;

		for (const part of chunk([...new Set(tags.map(x => x.toLowerCase()))], DB_BATCH_SIZE)) {
			const existing: { id: number, name: string }[] = await this.manager.query(
				`SELECT id, name FROM tags WHERE name IN (${part.map(() => '?').join(',')})`, part
			);
			existing.forEach(x => idByName.set(x.name, x.id));

			const missing = part.filter(x => !idByName.has(x));
			if (missing.length === 0) {
				continue;
			}

			await this.manager.query(`INSERT OR IGNORE INTO tags(name) VALUES ${missing.map(() => '(?)').join(',')}`, missing);
			const inserted: { id: number, name: string }[] = await this.manager.query(
				`SELECT id, name FROM tags WHERE name IN (${missing.map(() => '?').join(',')})`, missing
			);
			inserted.forEach(x => idByName.set(x.name, x.id));
			newCount += missing.length;
		}

		return { ids: [...idByName.values()], newCount };
	}

	/**
	 * Batch version of `addItem` for one item and many tags.
	 *
	 * @returns number of links that did not exist before.
	 */
	public async addItems(itemId: number, tagIds: number[]): Promise<number> {
		let added = 0;

		for (const part of chunk([...new Set(tagIds)], DB_BATCH_SIZE)) {
			const existing: { tagId: number }[] = await this.manager.query(
				`SELECT tagId FROM "items-to-tags" WHERE itemId = ? AND tagId IN (${part.map(() => '?').join(',')})`,
				[itemId, ...part]
			);
			const existingIds = new Set(existing.map(x => x.tagId));

			const toInsert = part.filter(x => !existingIds.has(x));
			if (toInsert.length !== 0) {
				await this.manager.query(
					`INSERT OR IGNORE INTO "items-to-tags"(itemId, tagId) VALUES ${toInsert.map(() => '(?,?)').join(',')}`,
					toInsert.flatMap(x => [itemId, x])
				);
				added += toInsert.length;
			}
		}

		return added;
	}

	public async addItem(tagId: number, itemId: number): Promise<boolean> {
		return await insertRelation(this.manager.getRepository(ItemToTagEntity), { itemId, tagId }, { lostRace: false });
	};
}
