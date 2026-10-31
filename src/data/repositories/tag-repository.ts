import { EntityManager } from 'typeorm';
import { InsertResult } from '../../models/insert-result';
import { ItemToTagEntity } from '../entities/item-to-tag-entity';
import { TagEntity } from '../entities/tag-entity';
import { insertRelation, insertUnique } from './insert-helpers';

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

	public async addItem(tagId: number, itemId: number): Promise<boolean> {
		return await insertRelation(this.manager.getRepository(ItemToTagEntity), { itemId, tagId }, { lostRace: false });
	};
}
