import { EntityManager, IsNull, LessThan, Or } from 'typeorm';
import { chunk, isNullOrUndefined } from '../../common/utils';
import { InsertResult } from '../../models/insert-result';
import { AccountEntity } from '../entities/account-entity';
import { FollowerEntity } from '../entities/follower-entity';
import { ItemToAccountEntity } from '../entities/item-to-account-entity';

const DB_BATCH_SIZE = 500;

export class AccountRepository {
	constructor(
		private readonly manager: EntityManager
	) {
	}

	public async getNotProcessed(): Promise<AccountEntity[]> {
		return await this.manager.getRepository(AccountEntity).find({
			// where: { lastProcessingDate: IsNull(), isBusy: false },
			where: { lastProcessingDate: Or(LessThan(new Date('2024-09-10')), IsNull()), isBusy: false },
			take: 400
		});
	}

	public async getAccountRelated(accountId: number): Promise<AccountEntity[]> {
		const itemIdsQuery = this.manager.getRepository(ItemToAccountEntity)
			.createQueryBuilder('itemToAccount')
			.select('itemToAccount.itemId')
			.where('itemToAccount.accountId = :accountId', { accountId })
			.getQuery();

		// Step 2: Get related accounts based on the retrieved item IDs
		const relatedAccounts = await this.manager.getRepository(AccountEntity)
			.createQueryBuilder('account')
			.innerJoin('account.itemToAccount', 'itemToAccount')
			.where(`itemToAccount.itemId IN (${itemIdsQuery})`)
			.andWhere('account.id != :accountId', { accountId })
			//.andWhere({ lastProcessingDate: LessThan('2024-08-21') })
			.getMany();

		return relatedAccounts;
	}

	public async getById(accountId: number): Promise<AccountEntity> {
		return await this.manager.getRepository(AccountEntity).findOne({ where: { id: accountId } });
	}

	public async insert(accountUrl: string): Promise<InsertResult<AccountEntity>> {
		const repository = this.manager.getRepository(AccountEntity);

		let existingRecord: AccountEntity = await repository.findOne({ where: { url: accountUrl } });
		if (!isNullOrUndefined(existingRecord)) {
			return { entity: existingRecord, isInserted: false };
		}

		try {
			const insertResult = await repository.insert({ url: accountUrl });
			return { entity: insertResult.generatedMaps[0] as AccountEntity, isInserted: true };
		} catch (error) {
			existingRecord = await repository.findOne({ where: { url: accountUrl } });
			if (!isNullOrUndefined(existingRecord)) {
				return { entity: existingRecord, isInserted: false, };
			}
			throw error;
		}
	};

	public async addItem(accountId: number, itemId: number, wishlist: boolean = false): Promise<boolean> {
		const repository = this.manager.getRepository(ItemToAccountEntity);

		let existingRecord = await repository.findOne({
			where: {
				itemId: itemId,
				accountId: accountId,
			}
		});

		if (!isNullOrUndefined(existingRecord)) {
			if (existingRecord.wishlist !== wishlist) {
				existingRecord.wishlist = wishlist;
				await repository.save(existingRecord);
			}
			return false;
		}

		try {
			await repository.insert({ itemId, accountId, wishlist });
			return true;
		} catch (error) {
			existingRecord = await repository.findOne({
				where: {
					itemId: itemId,
					accountId: accountId,
				}
			});
			if (!isNullOrUndefined(existingRecord)) {
				return true;
			}
			throw error;
		}
	};

	/**
	 * Batch version of `addItem`: links many items to one account with a few queries.
	 * Same rules as `addItem`: an existing relation is not counted as new, but its `wishlist` flag is updated.
	 *
	 * @returns number of relations that did not exist before.
	 */
	public async addItems(
		accountId: number,
		itemIds: number[],
		wishlist: boolean,
	): Promise<number> {
		let newRelations = 0;

		for (const part of chunk([...new Set(itemIds)], DB_BATCH_SIZE)) {
			const existing: { itemId: number, wishlist: number }[] = await this.manager.query(
				`SELECT itemId, wishlist FROM "items-to-accounts" WHERE accountId = ? AND itemId IN (${part.map(() => '?').join(',')})`,
				[accountId, ...part]
			);
			const existingIds = new Set(existing.map(x => x.itemId));

			const toUpdate = existing.filter(x => Boolean(x.wishlist) !== wishlist).map(x => x.itemId);
			if (toUpdate.length !== 0) {
				await this.manager.query(
					`UPDATE "items-to-accounts" SET wishlist = ? WHERE accountId = ? AND itemId IN (${toUpdate.map(() => '?').join(',')})`,
					[wishlist ? 1 : 0, accountId, ...toUpdate]
				);
			}

			const toInsert = part.filter(x => !existingIds.has(x));
			if (toInsert.length !== 0) {
				await this.manager.query(
					`INSERT OR IGNORE INTO "items-to-accounts"(itemId, accountId, wishlist) VALUES ${toInsert.map(() => '(?,?,?)').join(',')}`,
					toInsert.flatMap(x => [x, accountId, wishlist ? 1 : 0])
				);
				newRelations += toInsert.length;
			}
		}

		return newRelations;
	}

	public async addFollower(followedId: number, followerId: number): Promise<boolean> {
		const repository = this.manager.getRepository(FollowerEntity);

		let existingRecord = await repository.findOne({
			where: {
				followedId: followedId,
				followerId: followerId,
			}
		});

		if (!isNullOrUndefined(existingRecord)) {
			return false;
		}

		try {
			await repository.insert({ followedId, followerId });
			return true;
		} catch (error) {
			existingRecord = await repository.findOne({
				where: {
					followedId: followedId,
					followerId: followerId,
				}
			});
			if (!isNullOrUndefined(existingRecord)) {
				return true;
			}
			throw error;
		}
	};

	public async resetAllBusy(): Promise<void> {
		await this.manager.getRepository(AccountEntity)
			.createQueryBuilder()
			.update()
			.set({ isBusy: false })
			.where({ isBusy: true })
			.execute();
	}

	public async updateBusy(accountId: number, isBusy: boolean): Promise<void> {
		await this.manager.getRepository(AccountEntity).update({ id: accountId }, { isBusy });
	}

	public async updateFailed(accountId: number, clear: boolean = false): Promise<void> {
		await this.manager.getRepository(AccountEntity)
			.createQueryBuilder()
			.update()
			.set({ failedCount: clear ? 0 : () => 'COALESCE(failedCount, 0) + 1' })
			.where('id = :accountId', { accountId })
			.execute();
	}

	public async updateProcessingDate(accountId: number): Promise<void> {
		await this.manager.getRepository(AccountEntity)
			.update({ id: accountId }, { lastProcessingDate: new Date() });
	}

	public async removeByUrl(accountUrl: string): Promise<void> {
		const repository = this.manager.getRepository(AccountEntity)

		const existingRecord = await repository.findOne({ where: { url: accountUrl } });
		if (isNullOrUndefined(existingRecord)) {
			return;
		}

		await this.manager.getRepository(ItemToAccountEntity)
			.delete({ accountId: existingRecord.id });

		await repository.delete({ url: existingRecord.url });
	}
}
