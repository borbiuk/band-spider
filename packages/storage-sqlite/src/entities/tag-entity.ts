import { Column, Entity, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { ItemToTagEntity } from './item-to-tag-entity';
import { TagToSuperTagEntity } from './tag-to-super-tag-entity';

@Entity('tags')
export class TagEntity {

	@PrimaryGeneratedColumn()
	id: number;

	@Column({ type: 'text', unique: true })
	name: string;


	@OneToMany(() => ItemToTagEntity, (itemToTag) => itemToTag.tag)
	itemToTag: ItemToTagEntity[];


	@OneToMany(() => TagToSuperTagEntity, (tagToSuperTag) => tagToSuperTag.tag)
	tagToSuperTag: TagToSuperTagEntity[];
}
