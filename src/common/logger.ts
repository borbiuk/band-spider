import pretty from 'pino-pretty';
import fs from 'fs';
import clc from 'cli-color';

const pino = require('pino');

// Pretty print configuration for console output
const prettyStream = pretty({
	colorize: true,
	colorizeObjects: true,
	singleLine: true,
	ignore: 'pid,hostname',
});

const level = 'debug';
const file: boolean = false;

// Create the log file stream only when file logging is enabled
const fileStream = file ? fs.createWriteStream('logfile.log', { flags: 'a' }) : null;

// Log to console with pretty formatting
const consoleLogger = pino({ level }, prettyStream);

// Log to file
const fileLogger = file ? pino({ level }, fileStream) : null;

// Create a custom logger object to log to both console and file
export const logger = {
	info: (...args) => {
		consoleLogger.info(...args);
		if (file) {
			fileLogger.info(...args);
		}
	},
	debug: (...args) => {
		consoleLogger.debug(...args);
		if (file) {
			fileLogger.debug(...args);
		}
	},
	error: (...args) => {
		consoleLogger.error(...args);
		if (file) {
			fileLogger.error(...args);
		}
	},
	warn: (...args) => {
		consoleLogger.warn(...args);
		if (file) {
			fileLogger.warn(...args);
		}
	},
	fatal: (...args) => {
		consoleLogger.fatal(...args);
		if (file) {
			fileLogger.fatal(...args);
		}
	},
};

export const accountColor = clc.xterm(215);
export const albumColor = clc.xterm(229);
export const dateColor = clc.xterm(153)
export const followerColor = clc.xterm(190);
export const itemColor = clc.xterm(156);
export const tagColor = clc.xterm(151);
export const urlColor = clc.xterm(75);

export const errorColor = clc.xterm(203);
export const warningColor = clc.xterm(214);
export const speedColor = clc.xterm(226);
export const successColor = clc.xterm(112);

export enum LogSource {
	Main = '🚨️',
	Browser = '🖥 ',
	Page = '📄',
	Account = '🧢',
	Item = '📀',
	Tag = '🏷',
	Date = '📅',
	Proxy = '📡',
	Data = '🗄',
	Unknown = '❓',
}
