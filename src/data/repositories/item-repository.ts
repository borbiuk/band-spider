import { DataSource, IsNull, LessThan, MoreThan, Or } from 'typeorm';
import { ILike } from 'typeorm/find-options/operator/ILike';
import { isNullOrUndefined } from '../../common/utils';
import { InsertResult } from '../../models/insert-result';
import { ItemEntity } from '../entities/item-entity';
import { ItemToAccountEntity } from '../entities/item-to-account-entity';

export class ItemRepository {
	constructor(
		private readonly dataSource: DataSource
	) {
	}

	public async getNotProcessed(): Promise<ItemEntity[]> {
		return await this.dataSource.getRepository(ItemEntity).find({
			where: { lastProcessingDate: IsNull(), isBusy: false, failedCount: LessThan(1), url: Or(ILike('%/album/%'), ILike('%/track/%')) },
			take: 400
		});
	};

	public async getUserItems(accountId: number): Promise<ItemEntity[]> {
		return  await this.dataSource.getRepository(ItemEntity).createQueryBuilder('item')
			.innerJoin('item.itemToAccount', 'itemToAccount')
			.where('itemToAccount.accountId = :accountId', { accountId: accountId })
			//.where({ failedCount: MoreThan(0) })
			.getMany();
	}

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

	public async resetAllBusy(): Promise<void> {
		await this.dataSource.getRepository(ItemEntity)
			.createQueryBuilder()
			.update()
			.set({ isBusy: false })
			.where({ isBusy: true })
			.execute();
	}

	public async insert(itemUrl: string): Promise<InsertResult<ItemEntity>> {
		const repository = this.dataSource.getRepository(ItemEntity);

		let existingRecord = await repository.findOne({ where: { url: itemUrl } });
		if (existingRecord) {
			return { entity: existingRecord, isInserted: false };
		}

		try {
			const insertResult = await repository.insert({ url: itemUrl });
			return {entity: insertResult.generatedMaps[0] as ItemEntity, isInserted: true };
		} catch (error) {
			existingRecord = await repository.findOne({ where: { url: itemUrl } });
			if (isNullOrUndefined(existingRecord)) {
				throw error;
			}

			return {entity: null, isInserted: false };
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

	public async insertTrackToAlbum(trackUrl: string, album: ItemEntity): Promise<boolean> {
		const repository = this.dataSource.getRepository(ItemEntity);

		const { entity } = await this.insert(trackUrl);

		if (entity.albumId === album.id) {
			return false;
		}

		entity.albumId = album.id;
		await repository.save(entity);

		return true;
	}

	public async removeByUrl(itemUrl: string): Promise<void> {
		const repository = this.dataSource.getRepository(ItemEntity)

		const existingRecord = await repository.findOne({ where: { url: itemUrl } });
		if (isNullOrUndefined(existingRecord)) {
			return;
		}

		await this.dataSource.getRepository(ItemToAccountEntity)
			.delete({ itemId: existingRecord.id });

		await repository.delete({ url: existingRecord.url });
	}
}
