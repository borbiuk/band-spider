import { DataSource, IsNull, Not } from 'typeorm';
import { AccountEntity } from '../entities/account-entity';
import { ItemEntity } from '../entities/item-entity';
import { ItemToAccountEntity } from '../entities/item-to-account-entity';
import { ItemToTagEntity } from '../entities/item-to-tag-entity';
import { TagEntity } from '../entities/tag-entity';

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

	async getAllAccounts(): Promise<AccountEntity[]> {
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

	async getAllItems(): Promise<ItemEntity[]> {
		return await this.dataSource.getRepository(ItemEntity).find();
	};

	async getMostPopularItems(count: number, excludedUrls: string[] = []): Promise<{ url: string, count: number }[]> {
		const items = await this.dataSource
			.getRepository(ItemEntity)
			.createQueryBuilder('item')
			.leftJoin('item.itemToAccount', 'itemToAccount')
			.select(['item', 'COUNT(itemToAccount.accountId) AS accountCount'])
			.where('item.url NOT IN (:...excludedUrls)', { excludedUrls })
			.andWhere('item.url LIKE :urlPattern', { urlPattern: '%/track/%' })
			.groupBy('item.id')
			.orderBy('accountCount', 'DESC')
			.limit(count)
			.getRawMany();

		return items.map((item: any) => ({
			url: item.item_url,
			count: parseInt(item.accountCount)
		}));
	}

	async getAllAlbums(): Promise<ItemEntity[]> {
		return await this.dataSource.getRepository(ItemEntity).find({
			where: {
				album: IsNull()
			}
		});
	};

	async getAllTracks(): Promise<ItemEntity[]> {
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
