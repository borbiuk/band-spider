import fs from 'node:fs';
import { BandDatabase } from '../db';

/** The part of a better-sqlite3 connection that the migration uses. */
interface Connection {
	exec(sql: string): unknown;
	pragma(source: string, options?: { simple: boolean }): unknown;
	prepare(sql: string): { get(...parameters: unknown[]): unknown, run(...parameters: unknown[]): unknown };
	close(): unknown;
}

const Database = require('better-sqlite3') as new (file: string) => Connection;

/** Secondary indexes of v2. They are built after the data, which is faster than updating them row by row. */
const DEFERRED_INDEXES = ['idx_items_to_accounts_item', 'idx_items_album'];

/** Old table name -> new table name, for `sqlite_sequence`. */
const SEQUENCES: [string, string][] = [
	['accounts', 'accounts'],
	['items', 'items'],
	['tags', 'tags'],
	['super-tags', 'super_tags'],
];

/** Old date text `YYYY-MM-DD` -> unix seconds of its UTC midnight. */
const SECONDS = (column: string) => `CAST(strftime('%s', ${column}) AS INTEGER)`;
/** Old date text `YYYY-MM-DD` -> days since 1970-01-01. */
const DAYS = (column: string) => `CAST(julianday(${column}) - 2440587.5 AS INTEGER)`;
/** The account an old account id is merged into. */
const ACCOUNT = (column: string) => `COALESCE((SELECT newId FROM temp.account_merge WHERE oldId = ${column}), ${column})`;
/** The item an old item id is merged into. */
const ITEM = (column: string) => `COALESCE((SELECT newId FROM temp.item_merge WHERE oldId = ${column}), ${column})`;
const IS_ITEM_URL = (column: string) => `(${column} LIKE '%/track/%' OR ${column} LIKE '%/album/%')`;

/**
 * The steps of the migration, in order. Each is one SQL script. The data comes from the attached
 * old file `old`; the merge and drop lists are temp tables.
 */
const STEPS: [string, string][] = [
	['merge lists', `
		-- accounts whose URLs are equal after trim and lower-case: the lowest id is kept
		CREATE TEMP TABLE account_merge (oldId INTEGER PRIMARY KEY, newId INTEGER NOT NULL);
		INSERT INTO temp.account_merge
			SELECT id, keepId FROM (SELECT id, MIN(id) OVER (PARTITION BY lower(trim(url))) AS keepId FROM old.accounts)
			WHERE id <> keepId;

		-- items that are not a track or an album are dropped, with their links
		CREATE TEMP TABLE item_drop (id INTEGER PRIMARY KEY);
		INSERT INTO temp.item_drop SELECT id FROM old.items WHERE NOT ${IS_ITEM_URL('url')};

		-- an item URL with spaces whose trimmed URL exists already is merged into that item
		CREATE TEMP TABLE item_merge (oldId INTEGER PRIMARY KEY, newId INTEGER NOT NULL);
		INSERT INTO temp.item_merge
			SELECT a.id, b.id FROM old.items a JOIN old.items b ON b.url = trim(a.url)
			WHERE a.url <> trim(a.url) AND a.id NOT IN (SELECT id FROM temp.item_drop);
	`],
	['accounts', `
		INSERT INTO accounts (id, url, lastProcessingDate, isBusy, failedCount)
			SELECT ${ACCOUNT('id')}, lower(trim(MIN(url))), MAX(${SECONDS('lastProcessingDate')}), 0, MIN(failedCount)
			FROM old.accounts
			GROUP BY ${ACCOUNT('id')}
			ORDER BY 1;
	`],
	['items', `
		INSERT INTO items (id, url, type, albumId, releaseDate, imageUrl, lastProcessingDate, isBusy, failedCount)
			SELECT id, trim(url), CASE WHEN url LIKE '%/track/%' THEN 0 ELSE 1 END,
				CASE WHEN albumId IN (SELECT id FROM temp.item_drop) THEN NULL ELSE ${ITEM('albumId')} END,
				${DAYS('releaseDate')}, imageUrl, ${SECONDS('lastProcessingDate')}, 0, failedCount
			FROM old.items
			WHERE id NOT IN (SELECT id FROM temp.item_drop) AND id NOT IN (SELECT oldId FROM temp.item_merge)
			ORDER BY id;
	`],
	['tags', `
		INSERT INTO tags (id, name) SELECT id, name FROM old.tags ORDER BY id;
		INSERT INTO super_tags (id, name) SELECT id, name FROM old."super-tags" ORDER BY id;
		INSERT INTO tags_to_super_tags (tagId, superTagId)
			SELECT tagId, superTagId FROM old."tags-to-super-tags" ORDER BY tagId, superTagId;
	`],
	// a purchase wins over a wishlist link when two merged links meet: wishlist 0 sorts first
	['items_to_accounts', `
		INSERT OR IGNORE INTO items_to_accounts (accountId, itemId, wishlist)
			SELECT ${ACCOUNT('accountId')}, ${ITEM('itemId')}, wishlist
			FROM old."items-to-accounts"
			WHERE itemId NOT IN (SELECT id FROM temp.item_drop)
			ORDER BY 1, 2, 3;
	`],
	['items_to_tags', `
		INSERT OR IGNORE INTO items_to_tags (itemId, tagId)
			SELECT ${ITEM('itemId')}, tagId
			FROM old."items-to-tags"
			WHERE itemId NOT IN (SELECT id FROM temp.item_drop)
			ORDER BY itemId, tagId;
	`],
	['followers', `
		INSERT OR IGNORE INTO followers (followerId, followedId)
			SELECT ${ACCOUNT('followerId')}, ${ACCOUNT('followedId')}
			FROM old.followers
			WHERE ${ACCOUNT('followerId')} <> ${ACCOUNT('followedId')}
			ORDER BY followerId, followedId;
	`],
	// the marks of the kept account win; a merged account gives its marks only when the kept one has none
	['account_scans', `
		INSERT INTO account_scans (accountId, collection, wishlist, followers, following)
			SELECT accountId, collection, wishlist, followers, following FROM old."account-scans"
			WHERE accountId NOT IN (SELECT oldId FROM temp.account_merge)
			ORDER BY accountId;
		INSERT OR IGNORE INTO account_scans (accountId, collection, wishlist, followers, following)
			SELECT ${ACCOUNT('accountId')}, collection, wishlist, followers, following FROM old."account-scans"
			WHERE accountId IN (SELECT oldId FROM temp.account_merge)
			ORDER BY accountId;
	`],
	// new ids continue after the old maximum, also after rows that were deleted
	['sequences', SEQUENCES.map(([oldName, newName]) => `
		UPDATE sqlite_sequence SET seq = MAX(seq, (SELECT seq FROM old.sqlite_sequence WHERE name = '${oldName}'))
			WHERE name = '${newName}';
	`).join('')],
];

export interface MigrationOptions {
	/** Called with a line about each step. */
	log?: (line: string) => void;
}

/** What the migration did: the time of each step and the rows of each table in the new file. */
export interface MigrationReport {
	steps: { name: string, seconds: number }[];
	rows: Record<string, number>;
	merged: { accounts: number, items: number };
	droppedItems: number;
}

/**
 * Builds a v2 DB in `newFile` from the DB with the old schema in `oldFile`. The old file is only read.
 *
 * The schema of the new file is the one TypeORM makes from the entities, so a later sync sees no
 * difference. The new file must not exist; on an error it is deleted.
 */
export async function migrateToV2(oldFile: string, newFile: string, { log = () => undefined }: MigrationOptions = {}): Promise<MigrationReport> {
	if (!fs.existsSync(oldFile)) {
		throw new Error(`No old DB file: ${oldFile}`);
	}
	if (fs.existsSync(newFile)) {
		throw new Error(`The new DB file exists already: ${newFile}`);
	}
	assertV1(oldFile);

	try {
		// the schema exactly as TypeORM makes it
		await (await BandDatabase.open({ file: newFile, synchronize: true })).close();
		return copyData(oldFile, newFile, log);
	} catch (error) {
		for (const file of [newFile, `${newFile}-wal`, `${newFile}-shm`, `${newFile}-journal`]) {
			fs.rmSync(file, { force: true });
		}
		throw error;
	}
}

function assertV1(oldFile: string): void {
	const old = new Database(oldFile);
	try {
		const hasV1 = old.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'items-to-accounts'").get();
		if (!hasV1) {
			throw new Error(`The old DB file does not have the schema before v2: ${oldFile}`);
		}
	} finally {
		old.close();
	}
}

function copyData(oldFile: string, newFile: string, log: (line: string) => void): MigrationReport {
	const db = new Database(newFile);
	const steps: MigrationReport['steps'] = [];
	const run = (name: string, sql: string) => {
		const started = Date.now();
		db.exec(sql);
		const seconds = (Date.now() - started) / 1000;
		steps.push({ name, seconds });
		log(`${name}: ${seconds.toFixed(1)} s`);
	};

	try {
		// a new file: on an error it is deleted, so no journal is needed
		db.pragma('journal_mode = OFF');
		db.pragma('synchronous = OFF');
		db.pragma('foreign_keys = OFF');
		db.pragma('cache_size = -4000000');
		db.pragma('temp_store = FILE');
		db.pragma('threads = 4');

		const indexSql = DEFERRED_INDEXES.map(name => {
			const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?").get(name) as { sql: string } | undefined;
			if (!row) {
				throw new Error(`The TypeORM schema has no index ${name}`);
			}
			db.exec(`DROP INDEX "${name}"`);
			return row.sql;
		});

		// better-sqlite3 has no URI file names, so no `mode=ro`: the steps only read from `old`
		db.prepare('ATTACH DATABASE ? AS old').run(oldFile);

		for (const [name, sql] of STEPS) {
			run(name, `BEGIN; ${sql} COMMIT;`);
		}
		run('indexes', indexSql.join(';\n') + ';');

		const report: MigrationReport = {
			steps,
			rows: Object.fromEntries(['accounts', 'items', 'items_to_accounts', 'items_to_tags', 'followers', 'tags', 'super_tags', 'tags_to_super_tags', 'account_scans']
				.map(table => [table, Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n)])),
			merged: {
				accounts: Number((db.prepare('SELECT COUNT(*) AS n FROM temp.account_merge').get() as { n: number }).n),
				items: Number((db.prepare('SELECT COUNT(*) AS n FROM temp.item_merge').get() as { n: number }).n),
			},
			droppedItems: Number((db.prepare('SELECT COUNT(*) AS n FROM temp.item_drop').get() as { n: number }).n),
		};

		db.exec('DETACH DATABASE old');
		run('analyze', 'ANALYZE;');
		db.pragma('journal_mode = WAL');
		return report;
	} finally {
		db.close();
	}
}

/** The checks to run on a migrated file before it is used. Each returns the rows it found; all must be empty. */
export function checkV2(file: string, { log = () => undefined }: MigrationOptions = {}): { integrity: unknown[], foreignKeys: unknown[] } {
	const db = new Database(file);
	try {
		let started = Date.now();
		const integrity = (db.pragma('integrity_check') as { integrity_check: string }[]).filter(x => x.integrity_check !== 'ok');
		log(`integrity_check: ${((Date.now() - started) / 1000).toFixed(1)} s, ${integrity.length} problems`);

		started = Date.now();
		const foreignKeys = db.pragma('foreign_key_check') as unknown[];
		log(`foreign_key_check: ${((Date.now() - started) / 1000).toFixed(1)} s, ${foreignKeys.length} problems`);
		return { integrity, foreignKeys };
	} finally {
		db.close();
	}
}
