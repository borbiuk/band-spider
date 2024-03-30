import { Column, Entity, ManyToOne, PrimaryGeneratedColumn, Unique } from 'typeorm';
import { BaseEntity } from './base/enitity';
import { ItemEntity } from './item-entity';
import { TagEntity } from './tag-entity';

@Entity('items-to-tags')
@Unique(['itemId', 'tagId'])
export class ItemToTagEntity implements BaseEntity {

	@PrimaryGeneratedColumn()
	id: number;

	@Column()
	itemId: number;

	@ManyToOne(() => ItemEntity, (item) => item.itemToTag)
	item: ItemEntity;

	@Column()
	tagId: number;

	@ManyToOne(() => TagEntity, (item) => item.itemToTag)
	tag: TagEntity;

}
