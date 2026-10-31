import { Column, Entity, ManyToOne, PrimaryColumn } from 'typeorm';
import { AccountEntity } from './account-entity';
import { ItemEntity } from './item-entity';

@Entity('items-to-accounts')
export class ItemToAccountEntity {

	@PrimaryColumn()
	itemId: number;

	@ManyToOne(() => ItemEntity, (item) => item.itemToAccount)
	item: ItemEntity;


	@PrimaryColumn()
	accountId: number;

	@ManyToOne(() => AccountEntity, (account) => account.itemToAccount)
	account: AccountEntity;


	@Column({ type: 'boolean', default: false })
	wishlist: boolean;

}
