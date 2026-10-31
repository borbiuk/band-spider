import 'reflect-metadata';
import { logger, LogSource, logToFile } from './common/logger';
import { logMessage } from './common/utils';
import { BandSpiderOptions, parseOptions, readDatabaseConfig } from './config';
import { BandSpider } from './core/band-spider';
import { SuperTagUpdate } from './core/super-tag-update';
import { BandDatabase } from './data/db';

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
			return await new BandSpider(database).run(options);
		}
	} finally {
		await database.close();
	}
};


main().catch(error => {
	logger.fatal(error, logMessage(LogSource.Main, error.message));
});
