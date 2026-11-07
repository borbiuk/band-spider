import { Column, Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { AccountEntity } from './account-entity';

/**
 * Where the last complete read of each tab of an account began. Every value is the URL of a record
 * from the first (newest) batch of the tab, or null when the tab was empty. The next read of the tab
 * can stop after the batch that holds this URL: everything older was read already.
 *
 * The URLs are kept as the reader gave them, not normalized: the reader compares them with what it reads.
 */
@Entity('account_scans')
export class AccountScanEntity {

	@PrimaryColumn()
	accountId: number;

	@ManyToOne(() => AccountEntity)
	@JoinColumn({ name: 'accountId' })
	account: AccountEntity;

	@Column({ type: 'text', nullable: true })
	collection?: string;

	@Column({ type: 'text', nullable: true })
	wishlist?: string;

	@Column({ type: 'text', nullable: true })
	followers?: string;

	@Column({ type: 'text', nullable: true })
	following?: string;
}
