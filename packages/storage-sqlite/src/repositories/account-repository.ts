import { EntityManager } from 'typeorm';
import { AccountScanMarks, chunk, isNullOrUndefined } from '@band-spider/core';
import { InsertResult } from '../models/insert-result';
import { AccountEntity } from '../entities/account-entity';
import { AccountScanEntity } from '../entities/account-scan-entity';
import { FollowerEntity } from '../entities/follower-entity';
import { normalizeAccountUrl } from '../models/item-url';
import { ItemToAccountEntity } from '../entities/item-to-account-entity';
import { DB_BATCH_SIZE, insertManyByUrl, insertRelation, insertUnique } from './insert-helpers';
import { NEXT_FAILED_COUNT_SQL, NOT_FOUND_MARK, notProcessedWhere, processedWhere } from './selection';

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
			where: notProcessedWhere(),
			order: newestFirst ? { id: 'DESC' } : undefined,
			take: 400
		});
	}

	/** How many accounts are left to process. The filter is the one of `getNotProcessed`. */
	public async countNotProcessed(): Promise<number> {
		return await this.manager.getRepository(AccountEntity).count({
			where: notProcessedWhere(),
		});
	}

	public async countAll(): Promise<number> {
		return await this.manager.getRepository(AccountEntity).count();
	}

	/** How many accounts are processed. It is the opposite of the date filter of `countNotProcessed`. */
	public async countProcessed(): Promise<number> {
		return await this.manager.getRepository(AccountEntity).count({ where: processedWhere() });
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

	/** Inserts an account URL (trimmed and lower-cased first), or returns the account that has it. */
	public async insert(accountUrl: string): Promise<InsertResult<AccountEntity>> {
		const url = normalizeAccountUrl(accountUrl);
		return await insertUnique(
			this.manager.getRepository(AccountEntity),
			{ url },
			generated => ({ ...(generated as AccountEntity), url }),
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
				`SELECT itemId, wishlist FROM items_to_accounts WHERE accountId = ? AND itemId IN (${part.map(() => '?').join(',')})`,
				[accountId, ...part]
			);
			const existingIds = new Set(existing.map(x => x.itemId));

			const toUpdate = existing.filter(x => Boolean(x.wishlist) !== wishlist).map(x => x.itemId);
			if (toUpdate.length !== 0) {
				await this.manager.query(
					`UPDATE items_to_accounts SET wishlist = ? WHERE accountId = ? AND itemId IN (${toUpdate.map(() => '?').join(',')})`,
					[wishlist ? 1 : 0, accountId, ...toUpdate]
				);
			}

			const toInsert = part.filter(x => !existingIds.has(x));
			if (toInsert.length !== 0) {
				await this.manager.query(
					`INSERT OR IGNORE INTO items_to_accounts(itemId, accountId, wishlist) VALUES ${toInsert.map(() => '(?,?,?)').join(',')}`,
					toInsert.flatMap(x => [x, accountId, wishlist ? 1 : 0])
				);
				newRelations += toInsert.length;
			}
		}

		return newRelations;
	}

	/**
	 * Batch version of `insert` for many account URLs. Each URL ends up as `insert(url)` would leave it.
	 *
	 * @returns ids in the same order as `urls` (duplicates give the same id) and the URLs that did not exist before.
	 */
	public async insertMany(urls: string[]): Promise<{ ids: number[], newUrls: string[] }> {
		return await insertManyByUrl(this.manager, 'accounts', urls);
	}

	/**
	 * Batch version of `addItem` for one item and many accounts that support it (never a wishlist link).
	 * Same rules as `addItem`: an existing link is not counted as new, but a wishlist flag on it is cleared.
	 *
	 * @returns number of links that did not exist before.
	 */
	public async addSupporters(itemId: number, accountIds: number[]): Promise<number> {
		let added = 0;

		for (const part of chunk([...new Set(accountIds)], DB_BATCH_SIZE)) {
			const existing: { accountId: number, wishlist: number }[] = await this.manager.query(
				`SELECT accountId, wishlist FROM items_to_accounts WHERE itemId = ? AND accountId IN (${part.map(() => '?').join(',')})`,
				[itemId, ...part]
			);
			const existingIds = new Set(existing.map(x => x.accountId));

			const toUpdate = existing.filter(x => Boolean(x.wishlist)).map(x => x.accountId);
			if (toUpdate.length !== 0) {
				await this.manager.query(
					`UPDATE items_to_accounts SET wishlist = 0 WHERE itemId = ? AND accountId IN (${toUpdate.map(() => '?').join(',')})`,
					[itemId, ...toUpdate]
				);
			}

			const toInsert = part.filter(x => !existingIds.has(x));
			if (toInsert.length !== 0) {
				await this.manager.query(
					`INSERT OR IGNORE INTO items_to_accounts(itemId, accountId, wishlist) VALUES ${toInsert.map(() => '(?,?,0)').join(',')}`,
					toInsert.flatMap(x => [itemId, x])
				);
				added += toInsert.length;
			}
		}

		return added;
	}

	/**
	 * Batch version of `addFollower` for many follow pairs.
	 *
	 * @returns number of pairs that did not exist before.
	 */
	public async addFollowers(pairs: { followerId: number, followedId: number }[]): Promise<number> {
		const keyOf = (pair: { followerId: number, followedId: number }): string => `${pair.followerId}:${pair.followedId}`;
		const unique = [...new Map(pairs.map(pair => [keyOf(pair), pair])).values()];
		let added = 0;

		for (const part of chunk(unique, DB_BATCH_SIZE)) {
			const existing: { followerId: number, followedId: number }[] = await this.manager.query(
				`SELECT followerId, followedId FROM followers WHERE (followerId, followedId) IN (VALUES ${part.map(() => '(?,?)').join(',')})`,
				part.flatMap(x => [x.followerId, x.followedId])
			);
			const existingKeys = new Set(existing.map(keyOf));

			const toInsert = part.filter(x => !existingKeys.has(keyOf(x)));
			if (toInsert.length !== 0) {
				await this.manager.query(
					`INSERT OR IGNORE INTO followers(followerId, followedId) VALUES ${toInsert.map(() => '(?,?)').join(',')}`,
					toInsert.flatMap(x => [x.followerId, x.followedId])
				);
				added += toInsert.length;
			}
		}

		return added;
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
			.set({ failedCount: clear ? 0 : () => NEXT_FAILED_COUNT_SQL })
			.where('id = :accountId', { accountId })
			.execute();
	}

	/** The page does not exist: the account is not claimed again. */
	public async markNotFound(accountId: number): Promise<void> {
		await this.manager.getRepository(AccountEntity).update({ id: accountId }, { failedCount: NOT_FOUND_MARK });
	}

	public async updateProcessingDate(accountId: number): Promise<void> {
		await this.manager.getRepository(AccountEntity)
			.update({ id: accountId }, { lastProcessingDate: new Date() });
	}

	public async removeByUrl(accountUrl: string): Promise<void> {
		const repository = this.manager.getRepository(AccountEntity)

		const existingRecord = await repository.findOne({ where: { url: normalizeAccountUrl(accountUrl) } });
		if (isNullOrUndefined(existingRecord)) {
			return;
		}

		await this.manager.getRepository(ItemToAccountEntity)
			.delete({ accountId: existingRecord.id });

		await repository.delete({ url: existingRecord.url });
	}
}
