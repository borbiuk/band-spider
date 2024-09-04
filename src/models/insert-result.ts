import { BaseEntity } from '../data/entities/base/enitity';

export interface InsertResult<TEntity extends BaseEntity> {
	entity: TEntity;
	isInserted: boolean;
}
