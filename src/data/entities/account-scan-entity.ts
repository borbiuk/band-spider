import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * Where the last complete read of each tab of an account began. Every value is the URL of a record
 * from the first (newest) batch of the tab, or null when the tab was empty. The next read of the tab
 * can stop after the batch that holds this URL: everything older was read already.
 */
@Entity('account-scans')
export class AccountScanEntity {

	@PrimaryColumn()
	accountId: number;

	@Column({ length: 512, nullable: true })
	collection?: string;

	@Column({ length: 512, nullable: true })
	wishlist?: string;

	@Column({ length: 512, nullable: true })
	followers?: string;

	@Column({ length: 512, nullable: true })
	following?: string;
}
