import { Column, Entity, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { TagToSuperTagEntity } from './tag-to-super-tag-entity';

@Entity('super-tags')
export class SuperTagEntity {

	@PrimaryGeneratedColumn()
	id: number;

	@Column({ unique: true, length: 64 })
	name: string;


	@OneToMany(() => TagToSuperTagEntity, (tagToSuperTag) => tagToSuperTag.superTag)
	tagToSuperTag: TagToSuperTagEntity[];
}
