import { DataSource, IsNull, Not } from 'typeorm';
import { isNullOrUndefined } from '../common/utils';
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

export class BandDatabase {
	private static instance: BandDatabase;
	public readonly dataSource: DataSource;

	private constructor(dataSource: DataSource) {
		this.dataSource = dataSource;
	}

	static async initialize(): Promise<BandDatabase> {
		if (isNullOrUndefined(BandDatabase.instance)) {
			const dataSource = await appDataSource.initialize();
			BandDatabase.instance = new BandDatabase(dataSource);
		}

		return BandDatabase.instance;
	}

	async insertAccount(accountUrl: string): Promise<AccountEntity> {
		const repository = this.dataSource.getRepository(AccountEntity);

		const existingRecord = await repository.findOne({ where: { url: accountUrl } });
		if (existingRecord) {
			return existingRecord;
		}

		const insertResult = await repository.insert({ url: accountUrl });

		return insertResult.generatedMaps[0] as AccountEntity;
	};

	async getNotProcessedAccounts(): Promise<AccountEntity[]> {
		return await this.dataSource.getRepository(AccountEntity).find({ where: { lastProcessingDate: IsNull(), isBusy: false }, take: 100 });
	};

	async getAccountByUrl(accountUrl: string): Promise<AccountEntity> {
		return await this.dataSource.getRepository(AccountEntity)
			.findOne({ where: { url: accountUrl } });
	};

	async insertItem(itemUrl: string): Promise<ItemEntity> {
		const repository = this.dataSource.getRepository(ItemEntity);

		let existingRecord = await repository.findOne({ where: { url: itemUrl } });
		if (existingRecord) {
			return existingRecord;
		}

		try {
			const insertResult = await repository.insert({ url: itemUrl });
			return insertResult.generatedMaps[0] as ItemEntity;
		} catch (error) {
			existingRecord = await repository.findOne({ where: { url: itemUrl } });
			if (!existingRecord) {
				throw error;
			}

			return existingRecord;
		}
	};

	async getNotProcessedItems(): Promise<ItemEntity[]> {
		return await this.dataSource.getRepository(ItemEntity).find({ where: { lastProcessingDate: IsNull(), isBusy: false }, take: 100 });
	};

	async getItem(itemId: number): Promise<ItemEntity> {
		return await this.dataSource.getRepository(ItemEntity).findOne({ where: { id: itemId } });
	}

	async getAccount(accountId: number): Promise<AccountEntity> {
		return await this.dataSource.getRepository(AccountEntity).findOne({ where: { id: accountId } });
	}

	async updateAccountProcessingDate(accountId: number): Promise<void> {
		const account: AccountEntity = await this.getAccount(accountId);
		account.lastProcessingDate = new Date();
		await this.dataSource.getRepository(AccountEntity).save(account);
	}

	async updateAccountBusy(accountId: number, isBusy: boolean): Promise<void> {
		const account: AccountEntity = await this.getAccount(accountId);
		account.isBusy = isBusy;
		await this.dataSource.getRepository(AccountEntity).save(account);
	}

	async updateItemBusy(itemId: number, isBusy: boolean): Promise<void> {
		const item: ItemEntity = await this.getItem(itemId);
		item.isBusy = isBusy;
		await this.dataSource.getRepository(ItemEntity).save(item);
	}

	async updateAccountFailed(accountId: number, clear: boolean = false): Promise<void> {
		const account: AccountEntity = await this.getAccount(accountId);
		if (clear) {
			account.failedCount = 0;
		}
		else {
			account.failedCount = isNullOrUndefined(account.failedCount) ? 1 : (account.failedCount + 1);
		}
		await this.dataSource.getRepository(AccountEntity).save(account);
	}

	async updateItemFailed(itemId: number, clear: boolean = false): Promise<void> {
		const item: ItemEntity = await this.getItem(itemId);
		if (clear) {
			item.failedCount = 0;
		}
		else {
			item.failedCount = isNullOrUndefined(item.failedCount) ? 1 : (item.failedCount + 1);
		}
		await this.dataSource.getRepository(ItemEntity).save(item);
	}

	async isAccountAlreadyProcessed(url: string): Promise<boolean> {
		const existed: AccountEntity = await this.getAccountByUrl(url);
		return isNullOrUndefined(existed) ? false : !isNullOrUndefined(existed.lastProcessingDate);
	}

	async isAccountBusy(accountId: number): Promise<boolean> {
		const existed: AccountEntity = await this.getAccount(accountId);
		return isNullOrUndefined(existed) ? false : existed.isBusy === true;
	}

	async isItemBusy(itemId: number): Promise<boolean> {
		const existed: ItemEntity = await this.getItem(itemId);
		return isNullOrUndefined(existed) ? false : existed.isBusy === true;
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

	async getItemByUrl(itemUrl: string): Promise<ItemEntity> {
		return await this.dataSource.getRepository(ItemEntity)
			.findOne({ where: { url: itemUrl } });
	};

	async insertItemToAccount(itemId: number, accountId: number): Promise<boolean> {
		const repository = this.dataSource.getRepository(ItemToAccountEntity);

		let existingRecord = await repository.findOne({
			where: {
				itemId: itemId,
				accountId: accountId,
			}
		});

		if (existingRecord) {
			return false;
		}

		try {
			await repository.insert({ itemId, accountId });
			return true;
		} catch (error) {
			existingRecord = await repository.findOne({
				where: {
					itemId: itemId,
					accountId: accountId,
				}
			});
			if (existingRecord) {
				return true;
			}

			throw error;
		}
	};

	async updateItemReleaseDate(itemId: number, date: Date): Promise<boolean> {
		const item: ItemEntity = await this.getItem(itemId);
		if (!isNullOrUndefined(item.releaseDate)) {
			return false;
		}

		item.releaseDate = date;
		await this.dataSource.getRepository(ItemEntity).save(item);
		return true;
	}

	async updateItemProcessingDate(itemId: number): Promise<void> {
		const item: ItemEntity = await this.getItem(itemId);
		item.lastProcessingDate = new Date();
		await this.dataSource.getRepository(ItemEntity).save(item);
	}

	async isItemAlreadyProcessed(url: string): Promise<boolean> {
		const existed = await this.getItemByUrl(url);
		return isNullOrUndefined(existed) ? false : !isNullOrUndefined(existed.lastProcessingDate);
	}

	async insertTag(tag: string): Promise<TagEntity> {
		tag = tag.toLowerCase();

		const repository = this.dataSource.getRepository(TagEntity);

		let existingRecord = await repository.findOne({ where: { name: tag } });
		if (existingRecord) {
			return existingRecord;
		}

		try {
			const insertResult = await repository.insert({ name: tag });
			return insertResult.generatedMaps[0] as TagEntity;
		} catch (error) {
			existingRecord = await repository.findOne({ where: { name: tag } });
			if (existingRecord) {
				return existingRecord;
			}

			throw error;
		}
	};

	async insertItemToTag(itemId: number, tagId: number): Promise<boolean> {
		const repository = this.dataSource.getRepository(ItemToTagEntity);

		let existingRecord = await repository.findOne({
			where: {
				itemId: itemId,
				tagId: tagId,
			}
		});

		if (existingRecord) {
			return false;
		}

		try {
			await repository.insert({ itemId: itemId, tagId: tagId });
			return true;
		} catch (e) {
			existingRecord = await repository.findOne({
				where: {
					itemId: itemId,
					tagId: tagId,
				}
			});

			if (existingRecord) {
				return false;
			}

			throw e;
		}
	};

	async insertTrackToAlbum(trackUrl: string, albumUrl: string): Promise<boolean> {
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
}
