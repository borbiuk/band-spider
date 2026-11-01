import { CrawlStore, logger, logMessage, LogSource } from '@band-spider/core';
import { BandDatabase, LocalCrawlStore } from '@band-spider/storage-sqlite';
import { buildApp } from './app';
import { DbServiceConfig } from './config';
import { ServiceStats } from './stats';

export interface RunningDbService {
	/** The base URL with the real port, also when port 0 was asked. */
	readonly url: string;
	/** Finishes the requests that run now, stops listening and closes the DB. It is safe to call twice. */
	stop(): Promise<void>;
}

/**
 * The composition root of the DB service: the only place that knows the SQLite storage.
 * It opens the DB, owns the store (so it resets the busy flags) and starts the HTTP server.
 */
export const startDbService = async (config: DbServiceConfig): Promise<RunningDbService> => {
	logger.debug(logMessage(LogSource.Main, 'DB synchronizing...'));
	const database = await BandDatabase.open(config.database);
	let stopping: Promise<void> | undefined;

	try {
		const store: CrawlStore = new LocalCrawlStore(database, config.leaseMs);
		await store.resetBusy();

		const app = buildApp({ store, stats: new ServiceStats(), token: config.token });
		await app.listen({ host: config.host, port: config.port });

		const address = app.server.address();
		const port = typeof address === 'object' && address ? address.port : config.port;
		const url = `http://${config.host}:${port}`;
		logger.info(logMessage(LogSource.Main, `DB service ready: ${url}`));

		return {
			url,
			stop: () => stopping ??= (async () => {
				// close() waits for the requests that run now, so a save is never cut in the middle
				await app.close();
				await database.close();
			})(),
		};
	} catch (error) {
		await database.close();
		throw error;
	}
};
