import { Entity, ManyToOne, PrimaryColumn, Unique } from 'typeorm';
import { AccountEntity } from './account-entity';
import { BaseEntity } from './base/enitity';
import { ItemEntity } from './item-entity';

@Entity('items-to-accounts')
export class ItemToAccountEntity implements BaseEntity {

	@PrimaryColumn()
	itemId: number;

	@ManyToOne(() => ItemEntity, (item) => item.itemToAccount)
	item: ItemEntity;


	@PrimaryColumn()
	accountId: number;

	@ManyToOne(() => AccountEntity, (account) => account.itemToAccount)
	account: AccountEntity;

}
