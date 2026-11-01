import fs from 'node:fs';
import type { DatabaseConfig } from './data/db';
import { UrlType } from './models/url-type';

export interface BandSpiderOptions {
	concurrency: number,
	type: UrlType,
	superTag: boolean,
	/** Take the newest unprocessed URLs first (highest id), instead of the oldest. */
	reverse: boolean,
}

// Count of parallel URL workers.
export const PARALLEL_WORKERS_COUNT: number = 1;

/**
 * Reads the options from the command line arguments.
 *
 * @param args - The arguments after the script path (`process.argv.slice(2)`).
 */
export const parseOptions = (args: string[]): BandSpiderOptions => ({
	concurrency: PARALLEL_WORKERS_COUNT,
	type: args.includes('--account') ? UrlType.Account : UrlType.Item,
	superTag: args.includes('--superTag'),
	reverse: args.includes('--reverse'),
});

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
