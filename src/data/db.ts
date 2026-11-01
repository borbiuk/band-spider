import { DataSource, EntityManager } from 'typeorm';
import { AccountEntity } from './entities/account-entity';
import { AccountScanEntity } from './entities/account-scan-entity';
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

// SQLite tuning for a large (multi-GB) database with many small writes.
// WAL + synchronous NORMAL avoid an fsync on every commit; the cache and mmap speed up reads.
// With synchronous NORMAL the last commits can be lost on power loss, but the DB is not corrupted.
const SQLITE_BUSY_TIMEOUT_MS = 5000;
const SQLITE_CACHE_SIZE_KB = 512 * 1024;
// SQLite clamps this to its compile-time MAX_MMAP_SIZE, which is about 2 GB in better-sqlite3.
const SQLITE_MMAP_SIZE_BYTES = 8 * 1024 * 1024 * 1024;

export interface DatabaseConfig {
	/** Path of the SQLite file. */
	file: string,
	/** Create or update the schema from the entities when the DB is opened. */
	synchronize: boolean,
}

/**
 * Tables added after the schema of existing DB files was made. `synchronize` is off for an existing
 * file, so they are created here. The definitions are the same that TypeORM makes for a new file,
 * so a later sync sees no difference; a test checks that.
 */
export const SCHEMA_ADDITIONS: string[] = [
	'CREATE TABLE IF NOT EXISTS "account-scans" ("accountId" integer PRIMARY KEY NOT NULL, "collection" varchar(512), "wishlist" varchar(512), "followers" varchar(512), "following" varchar(512))',
];

/** The part of a better-sqlite3 connection that `prepareDatabase` uses. */
interface SqliteConnection {
	pragma(source: string): unknown;
}

/**
 * Sets the tuning pragmas on the raw connection. TypeORM calls it right after it opens the file, so
 * they apply to everything after, also to the schema sync of a new DB. `journal_mode = WAL` comes
 * from `enableWAL` and `busy_timeout` from `timeout`.
 */
const prepareDatabase = (connection: SqliteConnection): void => {
	connection.pragma('synchronous = NORMAL');
	connection.pragma(`cache_size = -${SQLITE_CACHE_SIZE_KB}`);
	connection.pragma(`mmap_size = ${SQLITE_MMAP_SIZE_BYTES}`);
	connection.pragma('temp_store = MEMORY');
};

const createDataSource = ({ file, synchronize }: DatabaseConfig): DataSource => new DataSource({
	type: 'better-sqlite3',
	database: file,
	synchronize,
	enableWAL: true,
	timeout: SQLITE_BUSY_TIMEOUT_MS,
	prepareDatabase,
	logging: false,
	migrations: [],
	entities: [
		AccountEntity,
		AccountScanEntity,
		FollowerEntity,
		ItemEntity,
		ItemToAccountEntity,
		ItemToTagEntity,
		SuperTagEntity,
		TagEntity,
		TagToSuperTagEntity,
	]
});

/**
 * The database of the app. The entry point opens it once and passes it to the code that needs it.
 *
 * TypeORM's better-sqlite3 driver uses one connection for everything. So a transaction is safe only
 * while one worker writes: a write of another worker during the transaction would become part of it.
 * LocalCrawlStore keeps this true: it runs its claims, saves and releases one at a time.
 */
export class BandDatabase {
	public readonly account: AccountRepository;
	public readonly item: ItemRepository;
	public readonly tag: TagRepository;
	public readonly superTag: SuperTagRepository;

	private constructor(
		private readonly dataSource: DataSource,
		private readonly manager: EntityManager,
	) {
		this.account = new AccountRepository(manager);
		this.item = new ItemRepository(manager);
		this.tag = new TagRepository(manager);
		this.superTag = new SuperTagRepository(manager);
	}

	/** Opens the SQLite file with the tuning pragmas, creates the schema if asked, and adds new tables. */
	public static async open(config: DatabaseConfig): Promise<BandDatabase> {
		const dataSource: DataSource = await createDataSource(config).initialize();
		for (const statement of SCHEMA_ADDITIONS) {
			await dataSource.query(statement);
		}
		return new BandDatabase(dataSource, dataSource.manager);
	}

	/**
	 * Runs `work` in one transaction. Everything written through the given database is part of it;
	 * the transaction is committed when `work` resolves and rolled back when it throws.
	 */
	public transaction<T>(work: (database: BandDatabase) => Promise<T>): Promise<T> {
		return this.manager.transaction(manager => work(new BandDatabase(this.dataSource, manager)));
	}

	/** Runs raw SQL. For maintenance code and tests. */
	public query(sql: string, parameters: unknown[] = []): Promise<any[]> {
		return this.manager.query(sql, parameters);
	}

	/** Closes the connection. */
	public async close(): Promise<void> {
		if (this.dataSource.isInitialized) {
			await this.dataSource.destroy();
		}
	}
}
