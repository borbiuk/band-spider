import { DataSource, IsNull } from 'typeorm';
import { isNullOrUndefined } from '../../common/utils';
import { AccountEntity } from '../../entities/account-entity';
import { ItemToAccountEntity } from '../../entities/item-to-account-entity';

export class AccountRepository {
	constructor(
		private readonly dataSource: DataSource
	) {
	}

	public async getNotProcessed(): Promise<AccountEntity[]> {
		return await this.dataSource.getRepository(AccountEntity).find({ where: { lastProcessingDate: IsNull(), isBusy: false }, take: 100 });
	};

	public async getById(accountId: number): Promise<AccountEntity> {
		return await this.dataSource.getRepository(AccountEntity).findOne({ where: { id: accountId } });
	}

	public async getByUrl(accountUrl: string): Promise<AccountEntity> {
		return await this.dataSource.getRepository(AccountEntity)
			.findOne({ where: { url: accountUrl } });
	};

	public async isAlreadyProcessed(url: string): Promise<boolean> {
		const existed: AccountEntity = await this.getByUrl(url);
		return isNullOrUndefined(existed) ? false : !isNullOrUndefined(existed.lastProcessingDate);
	}

	public async isBusy(accountId: number): Promise<boolean> {
		const existed: AccountEntity = await this.getById(accountId);
		return isNullOrUndefined(existed) ? false : existed.isBusy === true;
	}

	public async insert(accountUrl: string): Promise<AccountEntity> {
		const repository = this.dataSource.getRepository(AccountEntity);

		const existingRecord: AccountEntity = await repository.findOne({ where: { url: accountUrl } });
		if (existingRecord) {
			return existingRecord;
		}

		const insertResult = await repository.insert({ url: accountUrl });

		return insertResult.generatedMaps[0] as AccountEntity;
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

	public async clearAllBusy(): Promise<void> {
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
}
