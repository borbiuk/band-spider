import { EntityManager, ILike } from 'typeorm';
import { isNullOrUndefined } from '@band-spider/core';
import { InsertResult } from '../models/insert-result';
import { ItemEntity } from '../entities/item-entity';
import { ItemToAccountEntity } from '../entities/item-to-account-entity';
import { insertManyByUrl, insertUnique } from './insert-helpers';
import { NEXT_FAILED_COUNT_SQL, NOT_FOUND_MARK, notProcessedWhere, processedWhere } from './selection';

export class ItemRepository {
	constructor(
		private readonly manager: EntityManager
	) {
	}

	/**
	 * @param newestFirst - Take the items with the highest id first. Otherwise the order is not set,
	 * which in SQLite gives the lowest ids first.
	 */
	public async getNotProcessed(newestFirst: boolean = false): Promise<ItemEntity[]> {
		return await this.manager.getRepository(ItemEntity).find({
			where: this.notProcessedWhere(),
			order: newestFirst ? { id: 'DESC' } : undefined,
			take: 400
		});
	};

	/** How many items are left to process. The filter is the one of `getNotProcessed`. */
	public async countNotProcessed(): Promise<number> {
		return await this.manager.getRepository(ItemEntity).count({ where: this.notProcessedWhere() });
	}

	public async countAll(): Promise<number> {
		return await this.manager.getRepository(ItemEntity).count();
	}

	/** How many items were processed. It is the opposite of the date filter of `countNotProcessed`. */
	public async countProcessed(): Promise<number> {
		return await this.manager.getRepository(ItemEntity).count({ where: processedWhere() });
	}

	/** The shared filter of items and accounts, and only /track/ URLs. */
	private notProcessedWhere() {
		return { ...notProcessedWhere(), url: ILike('%/track/%') };
	}

	public async getUserItems(accountId: number): Promise<ItemEntity[]> {
		return await this.manager.getRepository(ItemEntity).createQueryBuilder('item')
			.innerJoin('item.itemToAccount', 'itemToAccount')
			.where('itemToAccount.accountId = :accountId', { accountId: accountId })
			//.where({ failedCount: MoreThan(0) })
			.getMany();
	}

	public async resetAllBusy(): Promise<void> {
		await this.manager.getRepository(ItemEntity)
			.createQueryBuilder()
			.update()
			.set({ isBusy: false })
			.where({ isBusy: true })
			.execute();
	}

	public async insert(itemUrl: string): Promise<InsertResult<ItemEntity>> {
		return await insertUnique(
			this.manager.getRepository(ItemEntity),
			{ url: itemUrl },
			generated => ({ ...(generated as ItemEntity), url: itemUrl }),
		);
	};

	/**
	 * Batch version of `insert` for the hot path: resolves many item URLs to ids with a few queries.
	 * Each URL ends up exactly as `insert(url)` would leave it (only `url` is set, the rest are column defaults).
	 *
	 * @returns ids in the same order as `urls` (duplicates give the same id) and the URLs that did not exist before.
	 */
	public async insertMany(urls: string[]): Promise<{ ids: number[], newUrls: string[] }> {
		return await insertManyByUrl(this.manager, 'items', urls);
	}

	public async updateReleaseDate(itemId: number, date: Date): Promise<boolean> {
		// Write only when the release date is not set yet
		const result = await this.manager.getRepository(ItemEntity)
			.createQueryBuilder()
			.update()
			.set({ releaseDate: date })
			.where('id = :itemId AND releaseDate IS NULL', { itemId })
			.execute();
		return result.affected > 0;
	}

	public async updateBusy(itemId: number, isBusy: boolean): Promise<void> {
		await this.manager.getRepository(ItemEntity).update({ id: itemId }, { isBusy });
	}

	public async updateFailed(itemId: number, clear: boolean = false): Promise<void> {
		await this.manager.getRepository(ItemEntity)
			.createQueryBuilder()
			.update()
			.set({ failedCount: clear ? 0 : () => NEXT_FAILED_COUNT_SQL })
			.where('id = :itemId', { itemId })
			.execute();
	}

	/** The page does not exist: the item is not claimed again. */
	public async markNotFound(itemId: number): Promise<void> {
		await this.manager.getRepository(ItemEntity).update({ id: itemId }, { failedCount: NOT_FOUND_MARK });
	}

	public async updateProcessingDate(itemId: number): Promise<void> {
		await this.manager.getRepository(ItemEntity)
			.update({ id: itemId }, { lastProcessingDate: new Date() });
	}

	public async updateImageUrl(itemId: number,  imageUrl: string): Promise<void> {
		if (isNullOrUndefined(imageUrl)) {
			return;
		}

		// Write only when the value differs
		await this.manager.getRepository(ItemEntity)
			.createQueryBuilder()
			.update()
			.set({ imageUrl })
			.where('id = :itemId AND (imageUrl IS NULL OR imageUrl <> :imageUrl)', { itemId, imageUrl })
			.execute();
	}

	public async updateTrackAlbum(trackId: number, albumId: number): Promise<boolean> {
		const repository = this.manager.getRepository(ItemEntity);

		const item = await repository.findOne({ where: { id: trackId } });
		if (item.albumId === albumId) {
			return false;
		}

		item.albumId = albumId;
		await repository.save(item);
		return true;
	}

	public async removeByUrl(itemUrl: string): Promise<void> {
		const repository = this.manager.getRepository(ItemEntity)

		const existingRecord = await repository.findOne({ where: { url: itemUrl } });
		if (isNullOrUndefined(existingRecord)) {
			return;
		}

		await this.manager.getRepository(ItemToAccountEntity)
			.delete({ itemId: existingRecord.id });

		await repository.delete({ url: existingRecord.url });
	}
}
