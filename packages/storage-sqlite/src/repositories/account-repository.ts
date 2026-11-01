import { EntityManager, IsNull, LessThan, MoreThanOrEqual, Or } from 'typeorm';
import { AccountScanMarks, chunk, isNullOrUndefined } from '@band-spider/core';
import { InsertResult } from '../models/insert-result';
import { AccountEntity } from '../entities/account-entity';
import { AccountScanEntity } from '../entities/account-scan-entity';
import { FollowerEntity } from '../entities/follower-entity';
import { ItemToAccountEntity } from '../entities/item-to-account-entity';
import { insertRelation, insertUnique } from './insert-helpers';

const DB_BATCH_SIZE = 500;

/** An account processed before this date is processed again. */
const REPROCESS_BEFORE = new Date('2024-09-10');

export class AccountRepository {
	constructor(
		private readonly manager: EntityManager
	) {
	}

	/**
	 * @param newestFirst - Take the accounts with the highest id first. Otherwise the order is not
	 * set, which in SQLite gives the lowest ids first.
	 */
	public async getNotProcessed(newestFirst: boolean = false): Promise<AccountEntity[]> {
		return await this.manager.getRepository(AccountEntity).find({
			// where: { lastProcessingDate: IsNull(), isBusy: false },
			where: { lastProcessingDate: Or(LessThan(REPROCESS_BEFORE), IsNull()), isBusy: false },
			order: newestFirst ? { id: 'DESC' } : undefined,
			take: 400
		});
	}

	/** How many accounts are left to process. The filter is the one of `getNotProcessed`. */
	public async countNotProcessed(): Promise<number> {
		return await this.manager.getRepository(AccountEntity).count({
			where: { lastProcessingDate: Or(LessThan(REPROCESS_BEFORE), IsNull()), isBusy: false },
		});
	}

	public async countAll(): Promise<number> {
		return await this.manager.getRepository(AccountEntity).count();
	}

	/** How many accounts are processed. It is the opposite of the filter of `countNotProcessed`, without the busy flag. */
	public async countProcessed(): Promise<number> {
		return await this.manager.getRepository(AccountEntity).count({ where: { lastProcessingDate: MoreThanOrEqual(REPROCESS_BEFORE) } });
	}

	/** How many links between an item and an account there are, and how many of them are a wishlist. */
	public async countItemRelations(): Promise<{ all: number, wishlist: number }> {
		const repository = this.manager.getRepository(ItemToAccountEntity);
		return { all: await repository.count(), wishlist: await repository.count({ where: { wishlist: true } }) };
	}

	public async countFollowers(): Promise<number> {
		return await this.manager.getRepository(FollowerEntity).count();
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
		return await insertUnique(
			this.manager.getRepository(AccountEntity),
			{ url: accountUrl },
			generated => generated as AccountEntity,
		);
	};

	public async addItem(accountId: number, itemId: number, wishlist: boolean = false): Promise<boolean> {
		const repository = this.manager.getRepository(ItemToAccountEntity);

		return await insertRelation(repository, { itemId, accountId }, {
			row: { itemId, accountId, wishlist },
			onExisting: async (existingRecord) => {
				if (existingRecord.wishlist !== wishlist) {
					existingRecord.wishlist = wishlist;
					await repository.save(existingRecord);
				}
			},
			lostRace: true,
		});
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
		return await insertRelation(this.manager.getRepository(FollowerEntity), { followedId, followerId }, { lostRace: true });
	};

	/** The marks of the last complete read of each tab; empty when the account was never read. */
	public async getScanMarks(accountId: number): Promise<AccountScanMarks> {
		const row = await this.manager.getRepository(AccountScanEntity).findOne({ where: { accountId } });
		if (isNullOrUndefined(row)) {
			return {};
		}

		const { collection, wishlist, followers, following } = row;
		return { collection, wishlist, followers, following };
	}

	/** Stores the marks of the tabs that were read to their end; other tabs keep their marks. */
	public async updateScanMarks(accountId: number, marks: AccountScanMarks): Promise<void> {
		const changed = Object.fromEntries(Object.entries(marks).filter(([, value]) => value !== undefined));
		if (Object.keys(changed).length === 0) {
			return;
		}

		const repository = this.manager.getRepository(AccountScanEntity);
		const existing = await repository.findOne({ where: { accountId } });
		await repository.save({ ...existing, ...changed, accountId });
	}

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
