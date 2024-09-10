import { Entity, ManyToOne, PrimaryColumn, Unique } from 'typeorm';
import { SuperTagEntity } from './super-tag-entity';
import { TagEntity } from './tag-entity';

@Entity('tags-to-super-tags')
export class TagToSuperTagEntity {
	@PrimaryColumn()
	tagId: number;

	@ManyToOne(() => TagEntity, (tag) => tag.tagToSuperTag)
	tag: TagEntity;


	@PrimaryColumn()
	superTagId: number;

	@ManyToOne(() => SuperTagEntity, (superTag) => superTag.tagToSuperTag)
	superTag: SuperTagEntity;
}
