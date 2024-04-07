import { Column, Entity, ManyToMany, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntity } from './base/enitity';
import { ItemEntity } from './item-entity';
import { ItemToAccountEntity } from './item-to-account-entity';

@Entity('accounts')
export class AccountEntity implements BaseEntity {

	@PrimaryGeneratedColumn()
	id: number;

	@Column({ unique: true })
	url: string;

	@ManyToMany(() => ItemEntity)
	items: ItemEntity[];

	@OneToMany(() => ItemToAccountEntity, (itemToTag) => itemToTag.account)
	itemToAccount: ItemToAccountEntity[];

	@Column({ type: 'date', nullable: true })
	lastProcessingDate?: Date;

}
