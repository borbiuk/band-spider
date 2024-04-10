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

// Log to console with pretty formatting
const consoleLogger = pino({ level: 'debug' }, prettyStream);

// Log to file
const fileLogger = pino({ level: 'debug' }, fileStream);

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

export enum Source {
	Main =    '[🚨️ MAIN___]',
	Browser = '[🖥 BROWSER]',
	Page =    '[📄 PAGE___]',
	Account = '[💁 ACCOUNT]',
	Item =    '[📀 ITEM___]',
	Tag =     '[🏷 TAG____]',
	Date =    '[📅 DATE___]',
}
