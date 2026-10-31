import { Entity, ManyToOne, PrimaryColumn } from 'typeorm';
import { ItemEntity } from './item-entity';
import { TagEntity } from './tag-entity';

@Entity('items-to-tags')
export class ItemToTagEntity {

	@PrimaryColumn()
	itemId: number;

	@ManyToOne(() => ItemEntity, (item) => item.itemToTag)
	item: ItemEntity;


	@PrimaryColumn()
	tagId: number;

	@ManyToOne(() => TagEntity, (tag) => tag.itemToTag)
	tag: TagEntity;
}
