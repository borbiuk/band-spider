import { DataSource } from 'typeorm';
import { isNullOrUndefined } from '../common/utils';
import { AccountEntity } from './entities/account-entity';
import { ItemEntity } from './entities/item-entity';
import { ItemToAccountEntity } from './entities/item-to-account-entity';
import { ItemToTagEntity } from './entities/item-to-tag-entity';
import { SuperTagEntity } from './entities/super-tag-entity';
import { TagEntity } from './entities/tag-entity';
import { TagToSuperTagEntity } from './entities/tag-to-super-tag-entity';
import { AccountRepository } from './repositories/account-repository';
import { ItemRepository } from './repositories/item-repository';
import { SuperTagRepository } from './repositories/super-tag-repository';
import { TagRepository } from './repositories/tag-repository';

const appDataSource: DataSource = new DataSource({
	type: 'sqlite',
	database: 'band_db.sqlite',
	synchronize: false,
	logging: false,
	migrations: [],
	entities: [
		AccountEntity,
		ItemEntity,
		TagEntity,
		ItemToTagEntity,
		ItemToAccountEntity,
		SuperTagEntity,
		TagToSuperTagEntity,
	]
});

export class BandDatabase {
	private static instance: BandDatabase;

	public readonly account: AccountRepository;
	public readonly item: ItemRepository;
	public readonly tag: TagRepository;
	public readonly superTag: SuperTagRepository;

	public readonly dataSource: DataSource;

	private constructor(dataSource: DataSource) {
		this.dataSource = dataSource;

		this.account = new AccountRepository(this.dataSource);
		this.item = new ItemRepository(this.dataSource);
		this.tag = new TagRepository(this.dataSource);
		this.superTag = new SuperTagRepository(this.dataSource);
	}

	public static async initialize(): Promise<BandDatabase> {
		if (isNullOrUndefined(BandDatabase.instance)) {
			const dataSource: DataSource = await appDataSource.initialize();
			BandDatabase.instance = new BandDatabase(dataSource);
		}

		return BandDatabase.instance;
	}
}
