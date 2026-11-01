import { Entity, PrimaryColumn } from 'typeorm';

@Entity('followers')
export class FollowerEntity {

	@PrimaryColumn()
	followerId: number;

	@PrimaryColumn()
	followedId: number;
}
