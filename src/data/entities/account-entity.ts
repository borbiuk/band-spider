import { Column, Entity, JoinColumn, ManyToMany, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntity } from './base/enitity';
import { FollowerEntity } from './follower-entity';
import { ItemEntity } from './item-entity';
import { ItemToAccountEntity } from './item-to-account-entity';

@Entity('accounts')
export class AccountEntity implements BaseEntity {

	@PrimaryGeneratedColumn()
	id: number;

	@Column({ unique: true })
	url: string;

	@Column({ type: 'date', nullable: true })
	lastProcessingDate?: Date;

	@Column({ type: 'boolean', default: false })
	isBusy: boolean;

	@Column({ type: 'integer', default: 0 })
	failedCount: number;


	@ManyToMany(() => ItemEntity)
	items: ItemEntity[];

	@OneToMany(() => ItemToAccountEntity, (itemToAccount) => itemToAccount.account)
	itemToAccount: ItemToAccountEntity[];


	@OneToMany(() => FollowerEntity, (follower) => follower.follower)
	followers: FollowerEntity[];

	@OneToMany(() => FollowerEntity, (follower) => follower.followed)
	followedBy: FollowerEntity[];
}
