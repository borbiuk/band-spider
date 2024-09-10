import { Column, Entity, ManyToMany, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { TagEntity } from './tag-entity';
import { TagToSuperTagEntity } from './tag-to-super-tag-entity';

@Entity('super-tags')
export class SuperTagEntity {

	@PrimaryGeneratedColumn()
	id: number;

	@Column({ unique: true, length: 64 })
	name: string;


	@ManyToMany(() => TagEntity)
	tags: TagEntity[];

	@OneToMany(() => TagToSuperTagEntity, (tagToSuperTag) => tagToSuperTag.superTag)
	tagToSuperTag: TagToSuperTagEntity[];
}
