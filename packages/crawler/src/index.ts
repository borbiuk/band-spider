import { logger, logMessage, LogSource, logToFile, stopOnSignals } from '@band-spider/core';
import {
	CrawlerConfig,
	parentMessageSchema,
	parseCrawlerConfig,
	PartialCrawlerConfig,
	readEnvConfig,
} from './config';
import { CrawlerEvent, runCrawler } from './crawler';

export * from './config';
export * from './counting-crawl-store';
export * from './crawl-transport';
export * from './crawler';
export * from './metrics';
export * from './mapping';
export * from './remote-crawl-store';

/** How long a forked crawler waits for its config message when the environment has no DB URL. */
const CONFIG_WAIT_MS = 10_000;

/** Waits for the first config message of the parent. */
const waitForConfig = (stop: AbortSignal, receive: (handler: (config: PartialCrawlerConfig) => void) => void): Promise<PartialCrawlerConfig> =>
	new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('Crawler config is missing: set CRAWLER_DB_URL or send a config message')), CONFIG_WAIT_MS);
		receive(config => {
			clearTimeout(timer);
			resolve(config);
		});
		stop.addEventListener('abort', () => {
			clearTimeout(timer);
			reject(new Error('Crawler was stopped before it got its config'));
		}, { once: true });
	});

const main = async (): Promise<void> => {
	// Log to the console and to the log file
	logToFile();

	// Ctrl-C stops the workers after the current URL, a second one exits at once
	const signalStop = stopOnSignals();
	// a stop message from the parent does the same
	const parentStop = new AbortController();
	const stop = AbortSignal.any([signalStop, parentStop.signal]);

	let onConfig: ((config: PartialCrawlerConfig) => void) | undefined;
	process.on('message', raw => {
		const message = parentMessageSchema.safeParse(raw);
		if (!message.success) {
			logger.warn(logMessage(LogSource.Main, 'Unknown message from the parent, ignored'));
		} else if (message.data.type === 'stop') {
			logger.warn(logMessage(LogSource.Main, 'Stop message: stopping after the current URL'));
			parentStop.abort();
		} else {
			onConfig?.(message.data.config);
		}
	});
	// started by the admin: stop when the admin is gone, so no crawler runs without it
	if (process.send) {
		process.once('disconnect', () => {
			if (!stop.aborted) {
				logger.warn(logMessage(LogSource.Main, 'The admin is gone: stopping after the current URL'));
				parentStop.abort();
			}
		});
	}

	// env first, an IPC message wins over it
	const fromEnv = readEnvConfig(process.env, process.argv.slice(2));
	let config: CrawlerConfig;
	if (fromEnv.dbUrl === undefined && process.send) {
		const fromParent = await waitForConfig(stop, handler => { onConfig = handler; });
		config = parseCrawlerConfig(fromEnv, fromParent);
	} else {
		config = parseCrawlerConfig(fromEnv);
	}

	const send = (event: CrawlerEvent): void => {
		process.send?.(event);
	};

	await runCrawler(config, { signal: stop, onEvent: send });
};

// Only the entry point starts the crawler, a test can import this file
if (require.main === module) {
	main().then(
		() => finish(),
		error => {
			logger.fatal(error, logMessage(LogSource.Main, error.message));
			process.exitCode = 1;
			finish();
		},
	);
}

/** Leaves after the IPC messages are flushed: an open IPC channel would keep the process alive. */
function finish(): void {
	if (process.connected) {
		process.once('disconnect', () => process.exit());
		process.disconnect();
	} else {
		process.exit();
	}
}
