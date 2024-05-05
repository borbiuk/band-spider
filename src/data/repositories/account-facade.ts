import { DataSource, IsNull, LessThan } from 'typeorm';
import { isNullOrUndefined } from '../../common/utils';
import { AccountEntity } from '../../entities/account-entity';
import { ItemToAccountEntity } from '../../entities/item-to-account-entity';

export class AccountRepository {
	constructor(
		private readonly dataSource: DataSource
	) {
	}

	public async getNotProcessed(): Promise<AccountEntity[]> {
		return await this.dataSource.getRepository(AccountEntity).find({
			where: { lastProcessingDate: IsNull(), isBusy: false, failedCount: LessThan(1) },
			take: 400
		});
	};

	public async getById(accountId: number): Promise<AccountEntity> {
		return await this.dataSource.getRepository(AccountEntity).findOne({ where: { id: accountId } });
	}

	public async insert(accountUrl: string): Promise<AccountEntity> {
		const repository = this.dataSource.getRepository(AccountEntity);

		let existingRecord: AccountEntity = await repository.findOne({ where: { url: accountUrl } });
		if (existingRecord) {
			return existingRecord;
		}

		try {
			const insertResult = await repository.insert({ url: accountUrl });
			return insertResult.generatedMaps[0] as AccountEntity;
		} catch (error) {
			existingRecord = await repository.findOne({ where: { url: accountUrl } });
			if (!existingRecord) {
				throw error;
			}

			return existingRecord;
		}
	};

	public async addItem(accountId: number, itemId: number): Promise<boolean> {
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

		await repository.delete(existingRecord);
	}
}
