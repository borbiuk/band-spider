import 'reflect-metadata';
import { logger, logMessage, LogSource, logToFile } from '@band-spider/core';
import { readServiceConfig } from './config';
import { startDbService } from './service';

export * from './app';
export * from './config';
export * from './mapping';
export * from './service';
export * from './stats';

/** Messages this process sends to its parent when it is started with fork. */
export const READY_MESSAGE_TYPE = 'ready';

const main = async (): Promise<void> => {
	// Log to the console and to the log file
	logToFile();

	const service = await startDbService(readServiceConfig());

	// a supervisor that started this process with fork waits for this message
	process.send?.({ type: READY_MESSAGE_TYPE, url: service.url });

	// The first signal stops after the current requests, a second one exits at once
	const stop = (reason: string, signal?: NodeJS.Signals): void => {
		logger.warn(logMessage(LogSource.Main, signal ? `${reason}: stopping, send it again to stop now` : `${reason}: stopping`));
		if (signal) {
			process.once(signal, () => process.exit(1));
		}
		service.stop().then(
			() => process.exit(0),
			error => {
				logger.fatal(error, logMessage(LogSource.Main, error.message));
				process.exit(1);
			},
		);
	};
	process.once('SIGINT', () => stop('SIGINT', 'SIGINT'));
	process.once('SIGTERM', () => stop('SIGTERM', 'SIGTERM'));
	// started by the admin: stop when the admin is gone, so the port and the DB are not kept busy
	if (process.send) {
		process.once('disconnect', () => stop('The admin is gone'));
	}
};

// Only the entry point starts the service, a test can import this file
if (require.main === module) {
	main().catch(error => {
		logger.fatal(error, logMessage(LogSource.Main, error.message));
		process.exitCode = 1;
	});
}
