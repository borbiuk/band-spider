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
	public readonly dataSource: DataSource;

	private constructor(dataSource: DataSource) {
		this.dataSource = dataSource;
	}

	static async initialize(): Promise<Database> {
		if (!Database.instance) {
			const dataSource = await appDataSource.initialize();
			Database.instance = new Database(dataSource);
		}

		return Database.instance;
	}

	async insertAccount(url: string): Promise<AccountEntity> {
		const repository = this.dataSource.getRepository(AccountEntity);

		const existingRecord = await repository.findOne({ where: { url } });
		if (existingRecord) {
			return existingRecord;
		}

		const insertResult = await repository.insert({ url });

		return insertResult.generatedMaps[0] as AccountEntity;
	};

	async getAllAccounts(): Promise<AccountEntity[]> {
		return await this.dataSource.getRepository(AccountEntity).find();
	};

	async getAccountId(url: string): Promise<AccountEntity> {
		return await this.dataSource.getRepository(AccountEntity)
			.findOne({ where: { url } });
	};

	async insertItem(url: string): Promise<ItemEntity> {
		const repository = this.dataSource.getRepository(ItemEntity);

		const existingRecord = await repository.findOne({ where: { url } });
		if (existingRecord) {
			return existingRecord;
		}

		const insertResult = await repository.insert({ url });

		return insertResult.generatedMaps[0] as ItemEntity;
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

	async getItemId(url: string): Promise<ItemEntity> {
		return await this.dataSource.getRepository(ItemEntity)
			.findOne({ where: { url } });
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

	async insertTag(tag: string): Promise<TagEntity> {
		tag = tag.toLowerCase();

		const repository = this.dataSource.getRepository(TagEntity);

		const existingRecord = await repository.findOne({ where: { name: tag } });
		if (existingRecord) {
			return existingRecord;
		}

		const insertResult = await repository.insert({ name: tag });

		return insertResult.generatedMaps[0] as TagEntity;
	};

	async insertItemToTag(itemId: number, tagId: number): Promise<boolean> {
		const repository = this.dataSource.getRepository(ItemToTagEntity);

		const existingRecord = await repository.findOne({
			where: {
				itemId: itemId,
				tagId: tagId,
			}
		});

		if (existingRecord) {
			return false;
		}

		await repository.insert({ itemId, tagId: tagId });

		return true;
	};

	public async insertTrackToAlbum(trackUrl: string, albumUrl: string): Promise<boolean> {
		const repository = this.dataSource.getRepository(ItemEntity);

		const track = await this.insertItem(trackUrl);
		const album = await this.insertItem(albumUrl);

		if (track.albumId === album.id) {
			return false;
		}

		track.albumId = album.id;
		await repository.save(track);

		return true;
	}

	// TODO: test it
	public async topItemsRelatedToAccount(accountId: number, count: number): Promise<ItemEntity[]> {
		const itemToAccountRepository = this.dataSource.getRepository(ItemToAccountEntity);
		const itemRepository = this.dataSource.getRepository(ItemEntity);

		// Query to find items related to accounts other than the given accountId
		const itemsQuery = itemRepository.createQueryBuilder('item')
			.leftJoinAndSelect('item.itemToAccount', 'itemToAccount')
			.leftJoinAndSelect('itemToAccount.account', 'account')
			.where('account.id != :accountId', { accountId });

		const test1 = await itemsQuery.getMany();

		// Subquery to get ids of items related to other accounts
		const subQuery = itemToAccountRepository.createQueryBuilder('itemToAccount')
			.select('DISTINCT("itemToAccount"."itemId")')
			.where('itemToAccount.accountId = :accountId', { accountId });

		const test2 = await subQuery.getMany();

		// Get the parameters from the subquery
		const subQueryParameters = subQuery.getParameters();

		// Final query to get top 'count' items not related to the given accountId
		const topItems = await itemsQuery
			.andWhere('item.id NOT IN (' + subQuery.getQuery() + ')')
			.setParameters({ ...subQueryParameters, accountId }) // Include accountId in parameters
			.take(count)
			.getMany();

		return topItems;
	}
}
