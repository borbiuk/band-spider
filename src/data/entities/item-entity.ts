import { Column, Entity, Index, JoinColumn, ManyToOne, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { ItemToAccountEntity } from './item-to-account-entity';
import { ItemToTagEntity } from './item-to-tag-entity';

@Entity('items')
export class ItemEntity {

	@PrimaryGeneratedColumn()
	id: number;

	@Column({ unique: true, length: 512 })
	url: string;

	@Column({ type: 'date', nullable: true })
	releaseDate?: Date;

	@Column({ length: 512, nullable: true })
	imageUrl?: string;

	@Column({ type: 'date', nullable: true })
	lastProcessingDate?: Date;

	@Column({ type: 'boolean', default: false })
	isBusy: boolean;

	@Column({ type: 'integer', default: 0 })
	failedCount: number;


	@Column({ nullable: true })
	@Index()
	albumId?: number;

	@ManyToOne(() => ItemEntity)
	@JoinColumn()
	album?: ItemEntity;


	@OneToMany(() => ItemToAccountEntity, (itemToAccount) => itemToAccount.item)
	itemToAccount: ItemToAccountEntity[]


	@OneToMany(() => ItemToTagEntity, (itemToTag) => itemToTag.item)
	itemToTag: ItemToTagEntity[];

}
