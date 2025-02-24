import { Column, Entity, Index, JoinColumn, ManyToMany, ManyToOne, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { AccountEntity } from './account-entity';
import { BaseEntity } from './base/enitity';
import { ItemToAccountEntity } from './item-to-account-entity';
import { ItemToTagEntity } from './item-to-tag-entity';
import { TagEntity } from './tag-entity';

@Entity('items')
export class ItemEntity implements BaseEntity {

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

	@ManyToOne(() => ItemEntity, (item) => item.albumId)
	@JoinColumn()
	album?: ItemEntity;


	@ManyToMany(() => AccountEntity)
	accounts: AccountEntity[];

	@OneToMany(() => ItemToAccountEntity, (itemToAccount) => itemToAccount.item)
	itemToAccount: ItemToAccountEntity[]


	@ManyToMany(() => TagEntity)
	tags: TagEntity[];

	@OneToMany(() => ItemToTagEntity, (itemToTag) => itemToTag.item)
	itemToTag: ItemToTagEntity[];

}
