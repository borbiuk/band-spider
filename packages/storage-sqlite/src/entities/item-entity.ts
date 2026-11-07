import { Column, Entity, Index, JoinColumn, ManyToOne, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { ItemType } from '../models/item-url';
import { ItemToAccountEntity } from './item-to-account-entity';
import { ItemToTagEntity } from './item-to-tag-entity';
import { epochDaysTransformer, unixSecondsTransformer } from './transformers';

@Entity('items')
export class ItemEntity {

	@PrimaryGeneratedColumn()
	id: number;

	/** Trimmed. Only track and album URLs are items. */
	@Column({ type: 'text', unique: true })
	url: string;

	/** Read from the URL when the item is inserted. */
	@Column({ type: 'integer' })
	type: ItemType;

	/** Days since 1970-01-01 in the DB. */
	@Column({ type: 'integer', nullable: true, transformer: epochDaysTransformer })
	releaseDate?: Date;

	@Column({ type: 'text', nullable: true })
	imageUrl?: string;

	/** Unix seconds in the DB. */
	@Column({ type: 'integer', nullable: true, transformer: unixSecondsTransformer })
	lastProcessingDate?: Date;

	@Column({ type: 'boolean', default: false })
	isBusy: boolean;

	@Column({ type: 'integer', default: 0 })
	failedCount: number;


	@Column({ nullable: true })
	@Index('idx_items_album')
	albumId?: number;

	@ManyToOne(() => ItemEntity)
	@JoinColumn()
	album?: ItemEntity;


	@OneToMany(() => ItemToAccountEntity, (itemToAccount) => itemToAccount.item)
	itemToAccount: ItemToAccountEntity[]


	@OneToMany(() => ItemToTagEntity, (itemToTag) => itemToTag.item)
	itemToTag: ItemToTagEntity[];

}
