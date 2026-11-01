import { EntityManager } from 'typeorm';
import { SuperTagEntity } from '../entities/super-tag-entity';
import { TagToSuperTagEntity } from '../entities/tag-to-super-tag-entity';
import { insertRelation } from './insert-helpers';

export class SuperTagRepository {
	constructor(
		private readonly manager: EntityManager
	) {
	}

	public async all(): Promise<SuperTagEntity[]> {
		return await this.manager.getRepository(SuperTagEntity).find();
	}

	public async addTag(superTagId: number, tagId: number): Promise<boolean> {
		return await insertRelation(this.manager.getRepository(TagToSuperTagEntity), { superTagId, tagId }, { lostRace: false });
	}
}
