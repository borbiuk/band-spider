import { Column, Entity, ManyToMany, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntity } from './base/enitity';
import { ItemEntity } from './item-entity';
import { ItemToTagEntity } from './item-to-tag-entity';
import { SuperTagEntity } from './super-tag-entity';
import { TagToSuperTagEntity } from './tag-to-super-tag-entity';

@Entity('tags')
export class TagEntity implements BaseEntity {

	@PrimaryGeneratedColumn()
	id: number;

	@Column({ unique: true, length: 64 })
	name: string;


	@ManyToMany(() => ItemEntity)
	items: ItemEntity[];

	@OneToMany(() => ItemToTagEntity, (itemToTag) => itemToTag.tag)
	itemToTag: ItemToTagEntity[];


	@ManyToMany(() => SuperTagEntity)
	superTags: SuperTagEntity[];

	@OneToMany(() => TagToSuperTagEntity, (tagToSuperTag) => tagToSuperTag.tag)
	tagToSuperTag: TagToSuperTagEntity[];
}
