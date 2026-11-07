import { Column, Entity, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { TagToSuperTagEntity } from './tag-to-super-tag-entity';

@Entity('super_tags')
export class SuperTagEntity {

	@PrimaryGeneratedColumn()
	id: number;

	@Column({ type: 'text', unique: true })
	name: string;


	@OneToMany(() => TagToSuperTagEntity, (tagToSuperTag) => tagToSuperTag.superTag)
	tagToSuperTag: TagToSuperTagEntity[];
}
