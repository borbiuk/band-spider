import { DataSource } from 'typeorm';
import { ItemToTagEntity } from '../../entities/item-to-tag-entity';
import { TagEntity } from '../../entities/tag-entity';

export class TagRepository {
	constructor(
		private readonly dataSource: DataSource
	) {
	}

	public async insert(tag: string): Promise<TagEntity> {
		tag = tag.toLowerCase();

		const repository = this.dataSource.getRepository(TagEntity);

		let existingRecord: TagEntity = await repository.findOne({ where: { name: tag } });
		if (existingRecord) {
			return existingRecord;
		}

		try {
			const insertResult = await repository.insert({ name: tag });
			return insertResult.generatedMaps[0] as TagEntity;
		} catch (error) {
			existingRecord = await repository.findOne({ where: { name: tag } });
			if (existingRecord) {
				return existingRecord;
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

		if (existingRecord) {
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
