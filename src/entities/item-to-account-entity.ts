import { Column, Entity, ManyToOne, PrimaryColumn, PrimaryGeneratedColumn, Unique } from 'typeorm';
import { AccountEntity } from './account-entity';
import { ItemEntity } from './item-entity';

@Entity('items-to-accounts')
@Unique(['itemId', 'accountId'])
export class ItemToAccountEntity {

	@PrimaryColumn()
	itemId: number;

	@ManyToOne(() => ItemEntity, (item) => item.itemToAccount)
	item: ItemEntity;

	@PrimaryColumn()
	accountId: number;

	@ManyToOne(() => AccountEntity, (item) => item.itemToAccount)
	account: AccountEntity;

}
