import { Column, Entity, JoinColumn, ManyToMany, OneToMany, OneToOne, PrimaryGeneratedColumn } from 'typeorm';
import { AccountEntity } from './account-entity';
import { ItemToAccountEntity } from './item-to-account-entity';
import { ItemToTagEntity } from './item-to-tag-entity';
import { TagEntity } from './tag-entity';

@Entity('items')
export class ItemEntity {

	@PrimaryGeneratedColumn()
	id: number;

	@Column({ unique: true })
	url: string;

	@OneToOne(() => ItemEntity)
	@JoinColumn()
	album?: ItemEntity;

	@ManyToMany(() => AccountEntity)
	accounts: AccountEntity[];

	@OneToMany(() => ItemToAccountEntity, (itemToAccount) => itemToAccount.item)
	itemToAccount: ItemToAccountEntity[]

	@ManyToMany(() => TagEntity)
	tags: TagEntity[];

	@OneToMany(() => ItemToTagEntity, (itemToTag) => itemToTag.item)
	itemToTag: ItemToTagEntity[]

}
