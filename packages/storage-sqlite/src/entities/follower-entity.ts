import { Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { AccountEntity } from './account-entity';

/** One account follows another. */
@Entity('followers', { withoutRowid: true })
export class FollowerEntity {

	@PrimaryColumn()
	followerId: number;

	@ManyToOne(() => AccountEntity)
	@JoinColumn({ name: 'followerId' })
	follower: AccountEntity;


	@PrimaryColumn()
	followedId: number;

	@ManyToOne(() => AccountEntity)
	@JoinColumn({ name: 'followedId' })
	followed: AccountEntity;
}
