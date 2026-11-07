import { Entity, ManyToOne, PrimaryColumn } from 'typeorm';
import { SuperTagEntity } from './super-tag-entity';
import { TagEntity } from './tag-entity';

@Entity('tags_to_super_tags', { withoutRowid: true })
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
