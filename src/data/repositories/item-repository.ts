import { DataSource, ILike, IsNull, LessThan, MoreThan, Or } from 'typeorm';
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
			where: {
				lastProcessingDate: IsNull(),
				isBusy: false,
				failedCount: LessThan(1),
				// url: Or(ILike('%/album/%'), ILike('%/track/%'))
				// url: ILike('%/album/%'),
				url: ILike('%/track/%'),
			},
			take: 400
		});
	};

	public async getUserItems(accountId: number): Promise<ItemEntity[]> {
		return await this.dataSource.getRepository(ItemEntity).createQueryBuilder('item')
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
		if (!isNullOrUndefined(existingRecord)) {
			return { entity: existingRecord, isInserted: false };
		}

		try {
			const insertResult = await repository.insert({ url: itemUrl });
			const insertedEntity: ItemEntity = {
				...(insertResult.generatedMaps[0] as ItemEntity),
				url: itemUrl,
			};
			return { entity: insertedEntity, isInserted: true };
		} catch (error) {
			existingRecord = await repository.findOne({ where: { url: itemUrl } });
			if (!isNullOrUndefined(existingRecord)) {
				return { entity: existingRecord, isInserted: false };
			}
			throw error;
		}
	};

	public async updateReleaseDate(itemId: number, date: Date): Promise<boolean> {
		// Write only when the release date is not set yet
		const result = await this.dataSource.getRepository(ItemEntity)
			.createQueryBuilder()
			.update()
			.set({ releaseDate: date })
			.where('id = :itemId AND releaseDate IS NULL', { itemId })
			.execute();
		return result.affected > 0;
	}

	public async updateBusy(itemId: number, isBusy: boolean): Promise<void> {
		await this.dataSource.getRepository(ItemEntity).update({ id: itemId }, { isBusy });
	}

	public async updateFailed(itemId: number, clear: boolean = false): Promise<void> {
		await this.dataSource.getRepository(ItemEntity)
			.createQueryBuilder()
			.update()
			.set({ failedCount: clear ? 0 : () => 'COALESCE(failedCount, 0) + 1' })
			.where('id = :itemId', { itemId })
			.execute();
	}

	public async updateProcessingDate(itemId: number): Promise<void> {
		await this.dataSource.getRepository(ItemEntity)
			.update({ id: itemId }, { lastProcessingDate: new Date() });
	}

	public async updateImageUrl(itemId: number,  imageUrl: string): Promise<void> {
		if (isNullOrUndefined(imageUrl)) {
			return;
		}

		// Write only when the value differs
		await this.dataSource.getRepository(ItemEntity)
			.createQueryBuilder()
			.update()
			.set({ imageUrl })
			.where('id = :itemId AND (imageUrl IS NULL OR imageUrl <> :imageUrl)', { itemId, imageUrl })
			.execute();
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

	public async updateTrackAlbum(trackId: number, albumId: number): Promise<boolean> {
		const repository = this.dataSource.getRepository(ItemEntity);

		const item = await repository.findOne({ where: { id: trackId } });
		if (item.albumId === albumId) {
			return false;
		}

		item.albumId = albumId;
		await repository.save(item);
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
