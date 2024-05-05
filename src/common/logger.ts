const pino = require('pino');
const pretty = require('pino-pretty');
const fs = require('fs');

// Create a writable stream to a log file
const fileStream = fs.createWriteStream('logfile.log', {flags: 'a'});

// Pretty print configuration for console output
const prettyStream = pretty({
	colorize: true,
	colorizeObjects: true,
	singleLine: true,
	ignore: 'pid,hostname',
});

const level = 'info'

// Log to console with pretty formatting
const consoleLogger = pino({ level }, prettyStream);

// Log to file
const fileLogger = pino({ level }, fileStream);

// Create a custom logger object to log to both console and file
export const logger = {
	info: (...args) => {
		consoleLogger.info(...args);
		fileLogger.info(...args);
	},
	debug: (...args) => {
		consoleLogger.debug(...args);
		fileLogger.debug(...args);
	},
	error: (...args) => {
		consoleLogger.error(...args);
		fileLogger.error(...args);
	},
	warn: (...args) => {
		consoleLogger.warn(...args);
		fileLogger.warn(...args);
	},
	fatal: (...args) => {
		consoleLogger.fatal(...args);
		fileLogger.fatal(...args);
	},
};

export enum LogSource {
	Main =    '[🚨️ MAIN   ]',
	Browser = '[🖥 BROWSER]',
	Page =    '[📄 PAGE   ]',
	Account = '[💁 ACCOUNT]',
	Item =    '[📀 ITEM   ]',
	Tag =     '[🏷 TAG    ]',
	Date =    '[📅 DATE   ]',
	Unknown = '[❓ UNKNOWN]',
}
