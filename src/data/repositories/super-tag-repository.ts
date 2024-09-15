import { DataSource } from 'typeorm';
import { isNullOrUndefined } from '../../common/utils';
import { ItemToTagEntity } from '../entities/item-to-tag-entity';
import { SuperTagEntity } from '../entities/super-tag-entity';
import { TagEntity } from '../entities/tag-entity';
import { TagToSuperTagEntity } from '../entities/tag-to-super-tag-entity';

export class SuperTagRepository {
	constructor(
		private readonly dataSource: DataSource
	) {
	}

	public async all(): Promise<SuperTagEntity[]> {
		return await this.dataSource.getRepository(SuperTagEntity).find();
	}

	public async addTag(superTagId: number, tagId: number): Promise<boolean> {
		const repository = this.dataSource.getRepository(TagToSuperTagEntity);

		let existedRecord = repository.findOne({ where: { superTagId: superTagId, tagId: tagId } });

		if (!isNullOrUndefined(existedRecord)) {
			return false;
		}

		try {
			await repository.insert({ superTagId: superTagId, tagId: tagId });
			return true;
		} catch (e) {
			let existedRecord = repository.findOne({ where: { superTagId: superTagId, tagId: tagId } });

			if (!isNullOrUndefined(existedRecord)) {
				return false;
			}

			throw e;
		}
	}
}
