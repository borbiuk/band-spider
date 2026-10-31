import clc from 'cli-color';
import pino, { Logger } from 'pino';
import pretty from 'pino-pretty';

const level = 'debug';

/** The log file of the app, relative to the working directory. */
export const LOG_FILE = 'logfile.log';

// Pretty print configuration for console output
const prettyStream = pretty({
	colorize: true,
	colorizeObjects: true,
	singleLine: true,
	ignore: 'pid,hostname',
});

// Every log line goes to all of these streams: the console now, the file after `logToFile`.
const streams = pino.multistream([{ level, stream: prettyStream }]);

export const logger: Logger = pino({ level }, streams);

/**
 * Also writes every log line to a file, as one JSON object per line. The entry point calls it, so
 * tests and scripts that only import the logger do not create the file.
 *
 * @param path - The log file. New lines are added at its end.
 */
export function logToFile(path: string = LOG_FILE): void {
	// sync writes: nothing is lost when the process exits
	streams.add({ level, stream: pino.destination({ dest: path, append: true, mkdir: true, sync: true }) });
}

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
	Data = '🗄',
	Unknown = '❓',
}
