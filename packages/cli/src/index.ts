import 'reflect-metadata';
import {
	BandSpider,
	BandSpiderOptions,
	logger,
	logMessage,
	LogSource,
	logToFile,
	parseOptions,
	stopOnSignals,
} from '@band-spider/core';
import { BandDatabase, LocalCrawlStore } from '@band-spider/storage-sqlite';
import { readDatabaseConfig } from './database-config';
import { SuperTagUpdate } from './super-tag-update';

/** Opens the database once for the whole run, with the log lines each mode printed before. */
const openDatabase = async (superTag: boolean): Promise<BandDatabase> => {
	const config = readDatabaseConfig();

	if (superTag) {
		logger.info('DB creating...');
		const database = await BandDatabase.open(config);
		logger.info('DB created');
		return database;
	}

	logger.debug('DB synchronizing...');
	const database = await BandDatabase.open(config);
	logger.debug('DB synchronized!');
	return database;
};

const main = async (): Promise<void> => {

	// Log to the console and to the log file
	logToFile();

	// Read arguments
	const args: string[] = process.argv.slice(2);
	const options: BandSpiderOptions = parseOptions(args);

	// Run
	const database = await openDatabase(options.superTag);
	try {
		if (options.superTag) {
			return await new SuperTagUpdate(database).run(options);
		} else {
			// Ctrl-C stops the workers after the current URL, so the DB is closed
			const store = new LocalCrawlStore(database);
			// this process owns the store, so it resets the busy flags
			logger.debug('DB preparing ...');
			await store.resetBusy();
			logger.debug('DB ready!');
			return await new BandSpider(store).run(options, stopOnSignals());
		}
	} finally {
		await database.close();
	}
};


main().catch(error => {
	logger.fatal(error, logMessage(LogSource.Main, error.message));
	process.exitCode = 1;
});
