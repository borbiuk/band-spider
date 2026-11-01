import fs from 'node:fs';
import type { DatabaseConfig } from '@band-spider/storage-sqlite';

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 4100;
const DEFAULT_DB_FILE = 'band_db.sqlite';

export interface DbServiceConfig {
	host: string;
	port: number;
	/** When set, every request except /health needs `Authorization: Bearer <token>`. */
	token?: string;
	/** How long a claimed URL stays taken. The store default is used when not set. */
	leaseMs?: number;
	database: DatabaseConfig;
}

/**
 * Reads the settings from the environment: DB_SERVICE_HOST, DB_SERVICE_PORT, DB_SERVICE_TOKEN,
 * DB_SERVICE_LEASE_MS, BAND_DB_PATH and DB_SYNCHRONIZE. Port 0 means a random free port.
 */
export const readServiceConfig = (env: NodeJS.ProcessEnv = process.env): DbServiceConfig => {
	const file = env.BAND_DB_PATH ?? DEFAULT_DB_FILE;
	const port = env.DB_SERVICE_PORT === undefined ? DEFAULT_PORT : Number(env.DB_SERVICE_PORT);
	if (!Number.isInteger(port) || port < 0 || port > 65535) {
		throw new Error(`DB_SERVICE_PORT is invalid: ${env.DB_SERVICE_PORT}`);
	}

	const leaseMs = env.DB_SERVICE_LEASE_MS === undefined ? undefined : Number(env.DB_SERVICE_LEASE_MS);
	if (leaseMs !== undefined && !(leaseMs > 0)) {
		throw new Error(`DB_SERVICE_LEASE_MS is invalid: ${env.DB_SERVICE_LEASE_MS}`);
	}

	return {
		host: env.DB_SERVICE_HOST ?? DEFAULT_HOST,
		port,
		token: env.DB_SERVICE_TOKEN || undefined,
		leaseMs,
		// same rule as the CLI: the schema is created only for a new file, or when asked
		database: {
			file,
			synchronize: env.DB_SYNCHRONIZE === 'true' || !fs.existsSync(file),
		},
	};
};
