import { DataSource, IsNull, LessThan } from 'typeorm';
import { isNullOrUndefined } from '../../common/utils';
import { InsertResult } from '../../models/insert-result';
import { AccountEntity } from '../entities/account-entity';
import { FollowerEntity } from '../entities/follower-entity';
import { ItemToAccountEntity } from '../entities/item-to-account-entity';

export class AccountRepository {
	constructor(
		private readonly dataSource: DataSource
	) {
	}

	public async getNotProcessed(): Promise<AccountEntity[]> {
		return await this.dataSource.getRepository(AccountEntity).find({
			// where: { lastProcessingDate: IsNull(), isBusy: false },
			where: { lastProcessingDate: LessThan(new Date('2024-08-01')), isBusy: false },
			take: 400
		});
	}

	public async getAccountRelated(accountId: number): Promise<AccountEntity[]> {
		const itemIdsQuery = this.dataSource.getRepository(ItemToAccountEntity)
			.createQueryBuilder('itemToAccount')
			.select('itemToAccount.itemId')
			.where('itemToAccount.accountId = :accountId', { accountId })
			.getQuery();

		// Step 2: Get related accounts based on the retrieved item IDs
		const relatedAccounts = await this.dataSource.getRepository(AccountEntity)
			.createQueryBuilder('account')
			.innerJoin('account.itemToAccount', 'itemToAccount')
			.where(`itemToAccount.itemId IN (${itemIdsQuery})`)
			.andWhere('account.id != :accountId', { accountId })
			//.andWhere({ lastProcessingDate: LessThan('2024-08-21') })
			.getMany();

		return relatedAccounts;
	}

	public async getById(accountId: number): Promise<AccountEntity> {
		return await this.dataSource.getRepository(AccountEntity).findOne({ where: { id: accountId } });
	}

	public async insert(accountUrl: string): Promise<InsertResult<AccountEntity>> {
		const repository = this.dataSource.getRepository(AccountEntity);

		let existingRecord: AccountEntity = await repository.findOne({ where: { url: accountUrl } });
		if (!isNullOrUndefined(existingRecord)) {
			return { entity: existingRecord, isInserted: false };
		}

		try {
			const insertResult = await repository.insert({ url: accountUrl });
			return { entity: insertResult.generatedMaps[0] as AccountEntity, isInserted: true };
		} catch (error) {
			existingRecord = await repository.findOne({ where: { url: accountUrl } });
			if (!existingRecord) {
				throw error;
			}

			return { entity: null, isInserted: false, };
		}
	};

	public async addItem(accountId: number, itemId: number, wishlist: boolean = false): Promise<boolean> {
		const repository = this.dataSource.getRepository(ItemToAccountEntity);

		let existingRecord = await repository.findOne({
			where: {
				itemId: itemId,
				accountId: accountId,
			}
		});

		if (existingRecord) {
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
			if (existingRecord) {
				return true;
			}

			throw error;
		}
	};

	public async addFollower(followedId: number, followerId: number): Promise<boolean> {
		const repository = this.dataSource.getRepository(FollowerEntity);

		let existingRecord = await repository.findOne({
			where: {
				followedId: followedId,
				followerId: followerId,
			}
		});

		if (existingRecord) {
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
			if (existingRecord) {
				return true;
			}

			throw error;
		}
	};

	public async resetAllBusy(): Promise<void> {
		await this.dataSource.getRepository(AccountEntity)
			.createQueryBuilder()
			.update()
			.set({ isBusy: false })
			.where({ isBusy: true })
			.execute();
	}

	public async updateBusy(accountId: number, isBusy: boolean): Promise<void> {
		const account: AccountEntity = await this.getById(accountId);
		account.isBusy = isBusy;
		await this.dataSource.getRepository(AccountEntity).save(account);
	}

	public async updateFailed(accountId: number, clear: boolean = false): Promise<void> {
		const account: AccountEntity = await this.getById(accountId);
		if (clear) {
			account.failedCount = 0;
		} else {
			account.failedCount = isNullOrUndefined(account.failedCount) ? 1 : (account.failedCount + 1);
		}
		await this.dataSource.getRepository(AccountEntity).save(account);
	}

	public async updateProcessingDate(accountId: number): Promise<void> {
		const account: AccountEntity = await this.getById(accountId);
		account.lastProcessingDate = new Date();
		await this.dataSource.getRepository(AccountEntity).save(account);
	}

	public async removeByUrl(accountUrl: string): Promise<void> {
		const repository = this.dataSource.getRepository(AccountEntity)

		const existingRecord = await repository.findOne({ where: { url: accountUrl } });
		if (isNullOrUndefined(existingRecord)) {
			return;
		}

		await this.dataSource.getRepository(ItemToAccountEntity)
			.delete({ accountId: existingRecord.id });

		await repository.delete({ url: existingRecord.url });
	}
}
