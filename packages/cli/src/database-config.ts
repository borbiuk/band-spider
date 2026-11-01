import fs from 'node:fs';
import type { DatabaseConfig } from '@band-spider/storage-sqlite';

/** The DB file used when `BAND_DB_PATH` is not set. */
export const DEFAULT_DB_FILE = 'band_db.sqlite';

/**
 * Reads the DB settings from the environment. `BAND_DB_PATH` overrides the file.
 *
 * The schema is created only for a new DB file, or when DB_SYNCHRONIZE=true is set explicitly.
 * Running synchronize on every start is slow on a big DB and can change the schema unexpectedly.
 */
export const readDatabaseConfig = (env: NodeJS.ProcessEnv = process.env): DatabaseConfig => {
	const file = env.BAND_DB_PATH ?? DEFAULT_DB_FILE;
	return {
		file,
		synchronize: env.DB_SYNCHRONIZE === 'true' || !fs.existsSync(file),
	};
};
