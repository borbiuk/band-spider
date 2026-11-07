import { Column, Entity, Index, ManyToOne, PrimaryColumn } from 'typeorm';
import { AccountEntity } from './account-entity';
import { ItemEntity } from './item-entity';

/**
 * An item in the collection or the wishlist of an account. The table is the primary key
 * `(accountId, itemId)`: "all items of an account" reads one range of it. The index serves
 * "all accounts of an item" and holds `wishlist`, so that read does not touch the table.
 */
@Entity('items_to_accounts', { withoutRowid: true })
@Index('idx_items_to_accounts_item', ['itemId', 'accountId', 'wishlist'])
export class ItemToAccountEntity {

	// declared first: TypeORM orders the primary key by the order of the columns
	@PrimaryColumn()
	accountId: number;

	@ManyToOne(() => AccountEntity, (account) => account.itemToAccount)
	account: AccountEntity;


	@PrimaryColumn()
	itemId: number;

	@ManyToOne(() => ItemEntity, (item) => item.itemToAccount)
	item: ItemEntity;


	@Column({ type: 'boolean', default: false })
	wishlist: boolean;

	/** When the account bought or wished the item, in unix seconds. Null when not known. */
	@Column({ type: 'integer', nullable: true })
	addedAt?: number;
}
