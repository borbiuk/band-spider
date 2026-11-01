import { Column, Entity, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { ItemToAccountEntity } from './item-to-account-entity';

@Entity('accounts')
export class AccountEntity {

	@PrimaryGeneratedColumn()
	id: number;

	@Column({ unique: true, length: 512 })
	url: string;

	@Column({ type: 'date', nullable: true })
	lastProcessingDate?: Date;

	@Column({ type: 'boolean', default: false })
	isBusy: boolean;

	@Column({ type: 'integer', default: 0 })
	failedCount: number;


	@OneToMany(() => ItemToAccountEntity, (itemToAccount) => itemToAccount.account)
	itemToAccount: ItemToAccountEntity[];
}
