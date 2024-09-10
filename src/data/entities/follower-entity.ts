import { BaseEntity, Entity, ManyToMany, PrimaryColumn, Unique } from 'typeorm';
import { AccountEntity } from './account-entity';

@Entity('followers')
export class FollowerEntity extends BaseEntity {

	@PrimaryColumn()
	followerId: number;

	@ManyToMany(() => AccountEntity, (account) => account.followers)
	follower: AccountEntity;


	@PrimaryColumn()
	followedId: number;

	@ManyToMany(() => AccountEntity, (account) => account.followedBy)
	followed: AccountEntity;
}
