import { Column, Entity, ManyToMany, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntity } from './base/enitity';
import { ItemEntity } from './item-entity';
import { ItemToTagEntity } from './item-to-tag-entity';

@Entity('tags')
export class TagEntity implements BaseEntity {

	@PrimaryGeneratedColumn()
	id: number;

	@Column({ unique: true })
	name: string;

	@ManyToMany(() => ItemEntity)
	items: ItemEntity[];

	@OneToMany(() => ItemToTagEntity, (itemToTag) => itemToTag.tag)
	itemToTag: ItemToTagEntity[]
}
