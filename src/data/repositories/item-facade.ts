import { DataSource, IsNull } from 'typeorm';
import { isNullOrUndefined } from '../../common/utils';
import { AccountEntity } from '../../entities/account-entity';
import { ItemEntity } from '../../entities/item-entity';

export class ItemRepository {
	constructor(
		private readonly dataSource: DataSource
	) {
	}


	public async getNotProcessed(): Promise<ItemEntity[]> {
		return await this.dataSource.getRepository(ItemEntity).find({ where: { lastProcessingDate: IsNull(), isBusy: false }, take: 100 });
	};

	public async getById(itemId: number): Promise<ItemEntity> {
		return await this.dataSource.getRepository(ItemEntity).findOne({ where: { id: itemId } });
	}

	public async getByUrl(itemUrl: string): Promise<ItemEntity> {
		return await this.dataSource.getRepository(ItemEntity)
			.findOne({ where: { url: itemUrl } });
	};

	public async isAlreadyProcessed(url: string): Promise<boolean> {
		const existed = await this.getByUrl(url);
		return isNullOrUndefined(existed) ? false : !isNullOrUndefined(existed.lastProcessingDate);
	}

	public async clearAllBusy(): Promise<void> {
		await this.dataSource.getRepository(ItemEntity)
			.createQueryBuilder()
			.update()
			.set({ isBusy: false })
			.where({ isBusy: true })
			.execute();
	}

	public async isBusy(itemId: number): Promise<boolean> {
		const existed: ItemEntity = await this.getById(itemId);
		return isNullOrUndefined(existed) ? false : existed.isBusy === true;
	}

	public async insert(itemUrl: string): Promise<ItemEntity> {
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

	public async updateReleaseDate(itemId: number, date: Date): Promise<boolean> {
		const item: ItemEntity = await this.getById(itemId);
		if (!isNullOrUndefined(item.releaseDate)) {
			return false;
		}

		item.releaseDate = date;
		await this.dataSource.getRepository(ItemEntity).save(item);
		return true;
	}

	public async updateBusy(itemId: number, isBusy: boolean): Promise<void> {
		const item: ItemEntity = await this.getById(itemId);
		item.isBusy = isBusy;
		await this.dataSource.getRepository(ItemEntity).save(item);
	}

	public async updateFailed(itemId: number, clear: boolean = false): Promise<void> {
		const item: ItemEntity = await this.getById(itemId);
		if (clear) {
			item.failedCount = 0;
		} else {
			item.failedCount = isNullOrUndefined(item.failedCount) ? 1 : (item.failedCount + 1);
		}
		await this.dataSource.getRepository(ItemEntity).save(item);
	}

	public async updateProcessingDate(itemId: number): Promise<void> {
		const item: ItemEntity = await this.getById(itemId);
		item.lastProcessingDate = new Date();
		await this.dataSource.getRepository(ItemEntity).save(item);
	}
}
