import { Entity, ManyToOne, PrimaryColumn, Unique } from 'typeorm';
import { BaseEntity } from './base/enitity';
import { ItemEntity } from './item-entity';
import { TagEntity } from './tag-entity';

@Entity('items-to-tags')
@Unique(['itemId', 'tagId'])
export class ItemToTagEntity implements BaseEntity {

	@PrimaryColumn()
	itemId: number;

	@ManyToOne(() => ItemEntity, (item) => item.itemToTag)
	item: ItemEntity;

	@PrimaryColumn()
	tagId: number;

	@ManyToOne(() => TagEntity, (tag) => tag.itemToTag)
	tag: TagEntity;
}
