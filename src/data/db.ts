import fs from 'fs';
import { DataSource } from 'typeorm';
import { isNullOrUndefined } from '../common/utils';
import { AccountEntity } from './entities/account-entity';
import { FollowerEntity } from './entities/follower-entity';
import { ItemEntity } from './entities/item-entity';
import { ItemToAccountEntity } from './entities/item-to-account-entity';
import { ItemToTagEntity } from './entities/item-to-tag-entity';
import { SuperTagEntity } from './entities/super-tag-entity';
import { TagEntity } from './entities/tag-entity';
import { TagToSuperTagEntity } from './entities/tag-to-super-tag-entity';
import { AccountRepository } from './repositories/account-repository';
import { ItemRepository } from './repositories/item-repository';
import { SuperTagRepository } from './repositories/super-tag-repository';
import { TagRepository } from './repositories/tag-repository';

const DB_FILE = 'band_db.sqlite';

// SQLite tuning for a large (multi-GB) database with many small writes.
// WAL + synchronous NORMAL avoid an fsync on every commit; the cache and mmap speed up reads.
// With synchronous NORMAL the last commits can be lost on power loss, but the DB is not corrupted.
const SQLITE_BUSY_TIMEOUT_MS = 5000;
const SQLITE_CACHE_SIZE_KB = 512 * 1024;
const SQLITE_MMAP_SIZE_BYTES = 8 * 1024 * 1024 * 1024;

// The schema is created only for a new DB file, or when DB_SYNCHRONIZE=true is set explicitly.
// Running synchronize on every start is slow on a big DB and can change the schema unexpectedly.
const synchronize: boolean = process.env.DB_SYNCHRONIZE === 'true' || !fs.existsSync(DB_FILE);

const appDataSource: DataSource = new DataSource({
	type: 'sqlite',
	database: DB_FILE,
	synchronize,
	enableWAL: true,
	busyTimeout: SQLITE_BUSY_TIMEOUT_MS,
	logging: false,
	migrations: [],
	entities: [
		AccountEntity,
		FollowerEntity,
		ItemEntity,
		ItemToAccountEntity,
		ItemToTagEntity,
		SuperTagEntity,
		TagEntity,
		TagToSuperTagEntity,
	]
});

export class BandDatabase {
	private static instance: BandDatabase;

	public readonly account: AccountRepository;
	public readonly item: ItemRepository;
	public readonly tag: TagRepository;
	public readonly superTag: SuperTagRepository;

	public readonly dataSource: DataSource;

	private constructor(dataSource: DataSource) {
		this.dataSource = dataSource;

		this.account = new AccountRepository(this.dataSource);
		this.item = new ItemRepository(this.dataSource);
		this.tag = new TagRepository(this.dataSource);
		this.superTag = new SuperTagRepository(this.dataSource);
	}

	private static async applyPragmas(dataSource: DataSource): Promise<void> {
		await dataSource.query('PRAGMA journal_mode = WAL');
		await dataSource.query('PRAGMA synchronous = NORMAL');
		await dataSource.query(`PRAGMA cache_size = -${SQLITE_CACHE_SIZE_KB}`);
		await dataSource.query(`PRAGMA mmap_size = ${SQLITE_MMAP_SIZE_BYTES}`);
		await dataSource.query('PRAGMA temp_store = MEMORY');
		await dataSource.query(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
	}

	public static async initialize(): Promise<BandDatabase> {
		if (isNullOrUndefined(BandDatabase.instance)) {
			const dataSource: DataSource = await appDataSource.initialize();
			await BandDatabase.applyPragmas(dataSource);
			BandDatabase.instance = new BandDatabase(dataSource);
		}

		return BandDatabase.instance;
	}
}
