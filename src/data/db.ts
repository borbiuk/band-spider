import { DataSource } from 'typeorm';
import { logger, LogSource } from '../common/logger';
import { isNullOrUndefined, logMessage } from '../common/utils';
import { AccountEntity } from './entities/account-entity';
import { ItemEntity } from './entities/item-entity';
import { ItemToAccountEntity } from './entities/item-to-account-entity';
import { ItemToTagEntity } from './entities/item-to-tag-entity';
import { TagEntity } from './entities/tag-entity';
import { AccountRepository } from './repositories/account-facade';
import { ItemRepository } from './repositories/item-facade';
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
	]
});

export class BandDatabase {
	private static instance: BandDatabase;

	public readonly account: AccountRepository;
	public readonly item: ItemRepository;
	public readonly tag: TagRepository;

	private readonly dataSource: DataSource;

	private constructor(dataSource: DataSource) {
		this.dataSource = dataSource;

		this.account = new AccountRepository(this.dataSource);
		this.item = new ItemRepository(this.dataSource);
		this.tag = new TagRepository(this.dataSource);
	}

	public static async initialize(): Promise<BandDatabase> {
		if (isNullOrUndefined(BandDatabase.instance)) {
			const dataSource: DataSource = await appDataSource.initialize();
			if (!isNullOrUndefined(BandDatabase.instance)) {
				logger.error(logMessage(LogSource.Data, 'Singleton failed'));
			}
			else {
				BandDatabase.instance = new BandDatabase(dataSource);
			}
		}

		return BandDatabase.instance;
	}
}
