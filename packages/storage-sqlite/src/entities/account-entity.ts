import { Column, Entity, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { ItemToAccountEntity } from './item-to-account-entity';
import { unixSecondsTransformer } from './transformers';

@Entity('accounts')
export class AccountEntity {

	@PrimaryGeneratedColumn()
	id: number;

	/** Trimmed and lower-cased: Bandcamp fan URLs do not depend on case. */
	@Column({ type: 'text', unique: true })
	url: string;

	/** Unix seconds in the DB. */
	@Column({ type: 'integer', nullable: true, transformer: unixSecondsTransformer })
	lastProcessingDate?: Date;

	@Column({ type: 'boolean', default: false })
	isBusy: boolean;

	@Column({ type: 'integer', default: 0 })
	failedCount: number;


	@OneToMany(() => ItemToAccountEntity, (itemToAccount) => itemToAccount.account)
	itemToAccount: ItemToAccountEntity[];
}
