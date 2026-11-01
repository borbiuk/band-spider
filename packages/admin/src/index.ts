import { logger, logMessage, LogSource, logToFile } from '@band-spider/core';
import { readAdminConfig, startAdmin } from './service';

export * from './app';
export * from './config';
export * from './config-store';
export * from './errors';
export * from './managed-child';
export * from './process-launcher';
export * from './ring-buffer';
export * from './secrets';
export * from './security';
export * from './service';
export * from './supervisor';
export * from './ui';
export * from './ui-render';

const main = async (): Promise<void> => {
	// Log to the console and to the log file
	logToFile();

	const admin = await startAdmin(readAdminConfig());
	logger.info(logMessage(LogSource.Main, `Admin API: ${admin.url}, open ${admin.sessionUrl}`));

	// The first signal stops the children and then the server, a second one exits at once
	const stop = (name: string): void => {
		logger.warn(logMessage(LogSource.Main, `${name}: stopping all processes, send it again to stop now`));
		process.once(name as NodeJS.Signals, () => process.exit(1));
		admin.stop().then(
			() => process.exit(0),
			error => {
				logger.fatal(error, logMessage(LogSource.Main, error.message));
				process.exit(1);
			},
		);
	};
	process.once('SIGINT', () => stop('SIGINT'));
	process.once('SIGTERM', () => stop('SIGTERM'));
};

// Only the entry point starts the admin, a test can import this file
if (require.main === module) {
	main().catch(error => {
		logger.fatal(error, logMessage(LogSource.Main, error.message));
		process.exitCode = 1;
	});
}
