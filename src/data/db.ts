import { DataSource, IsNull, Not } from 'typeorm';
import { AccountEntity } from '../entities/account-entity';
import { ItemEntity } from '../entities/item-entity';
import { ItemToAccountEntity } from '../entities/item-to-account-entity';
import { ItemToTagEntity } from '../entities/item-to-tag-entity';
import { TagEntity } from '../entities/tag-entity';
import { Account } from '../models/account';
import { Album } from '../models/album';
import { Track } from '../models/track';

const appDataSource = new DataSource({
	type: 'sqlite',
	database: 'band_db.sqlite',
	synchronize: true,
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

export class Database {
	private static instance: Database;
	private readonly dataSource: DataSource;

	private constructor(dataSource: DataSource) {
		this.dataSource = dataSource;
	}

	static async initialize() : Promise<Database> {
		if (!Database.instance) {
			const dataSource = await appDataSource.initialize();
			Database.instance = new Database(dataSource);
		}

		return Database.instance;
	}

	async insertAccount (url: string): Promise<number> {
		const repository = this.dataSource.getRepository(AccountEntity);

		const existingRecord = await repository.findOne({ where: { url } });
		if (existingRecord) {
			return existingRecord.id;
		}

		const newRecord = (await repository.insert({ url }))
			.generatedMaps[0] as AccountEntity;

		return newRecord.id;
	};

	async getAllAccounts(): Promise<Account[]> {
		return await this.dataSource.getRepository(AccountEntity).find();
	};

	async getAccountId (url: string): Promise<number> {
		const account = await this.dataSource.getRepository(AccountEntity)
			.findOne({ where: { url } });
		return account?.id;
	};

	async insertItem(url: string): Promise<number> {
		const repository = this.dataSource.getRepository(ItemEntity);

		const existingRecord = await repository.findOne({ where: { url } });
		if (existingRecord) {
			return existingRecord.id;
		}

		const newRecord = (await repository.insert({ url }))
			.generatedMaps[0] as ItemEntity;

		return newRecord.id;
	};

	async getAllAlbums(): Promise<Album[]> {
		return await this.dataSource.getRepository(ItemEntity).find({
			where: {
				album: IsNull()
			}
		});
	};

	async getAllTracks(): Promise<Track[]> {
		return await this.dataSource.getRepository(ItemEntity).find({
			where: {
				album: Not(IsNull())
			}
		});
	};

	async getItemId (url: string): Promise<number> {
		const item = await this.dataSource.getRepository(ItemEntity)
			.findOne({ where: { url } });

		return item?.id;
	};

	async insertItemToAccount(itemId: number, accountId: number): Promise<boolean> {
		const repository = this.dataSource.getRepository(ItemToAccountEntity);

		const existingRecord = await repository.findOne({
			where: {
				itemId: itemId,
				accountId: accountId,
			}
		});

		if (existingRecord) {
			return false;
		}

		await repository.insert({ itemId, accountId });

		return true;
	};
}
