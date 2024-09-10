import { DataSource } from 'typeorm';
import { isNullOrUndefined } from '../../common/utils';
import { InsertResult } from '../../models/insert-result';
import { ItemToTagEntity } from '../entities/item-to-tag-entity';
import { TagEntity } from '../entities/tag-entity';

export class TagRepository {
	constructor(
		private readonly dataSource: DataSource
	) {
	}

	public async getAll(
		page: number = 1,
		pageSize: number = 10
	): Promise<TagEntity[]> {
		const repository = this.dataSource.getRepository(TagEntity);

		return await repository.find({
			skip: (page - 1) * pageSize,
			take: pageSize,
		});
	}

	public async insert(tag: string): Promise<InsertResult<TagEntity>> {
		tag = tag.toLowerCase();

		const repository = this.dataSource.getRepository(TagEntity);

		let existingRecord: TagEntity = await repository.findOne({ where: { name: tag } });
		if (existingRecord) {
			return { entity: existingRecord, isInserted: false };
		}

		try {
			const insertResult = await repository.insert({ name: tag });
			return {
				entity: insertResult.generatedMaps[0] as TagEntity,
				isInserted: true,
			};
		} catch (error) {
			existingRecord = await repository.findOne({ where: { name: tag } });
			if (existingRecord) {
				return {
					entity: existingRecord,
					isInserted: false,
				};
			}

			throw error;
		}
	};

	public async addItem(tagId: number, itemId: number): Promise<boolean> {
		const repository = this.dataSource.getRepository(ItemToTagEntity);

		let existingRecord: ItemToTagEntity = await repository.findOne({
			where: {
				itemId: itemId,
				tagId: tagId,
			}
		});

		if (!isNullOrUndefined(existingRecord)) {
			return false;
		}

		try {
			await repository.insert({ itemId: itemId, tagId: tagId });
			return true;
		} catch (e) {
			existingRecord = await repository.findOne({
				where: {
					itemId: itemId,
					tagId: tagId,
				}
			});

			if (existingRecord) {
				return false;
			}

			throw e;
		}
	};
}
