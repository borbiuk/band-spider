import clc from 'cli-color';
import pino, { DestinationStream, Logger } from 'pino';
import pretty, { PrettyOptions } from 'pino-pretty';

const level = 'debug';

/** The log file of the app, relative to the working directory. */
export const LOG_FILE = 'logfile.log';

/** Pretty print configuration for console output. */
export const PRETTY_OPTIONS: PrettyOptions = {
	colorize: true,
	colorizeObjects: true,
	singleLine: true,
	ignore: 'pid,hostname',
	// pino-pretty removes control characters from a message, so the escape character of the color
	// codes is lost and the rest of the code (e.g. `[38;5;75m`) is printed as text.
	// A message format function is the one path that keeps the message as it is.
	messageFormat: (log, messageKey) => String(log[messageKey] ?? ''),
};

const prettyStream = pretty(PRETTY_OPTIONS);

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
	const file = pino.destination({ dest: path, append: true, mkdir: true, sync: true });
	streams.add({ level, stream: withoutColors(file) });
}

// A terminal color code as it is written in a JSON string, e.g. `\u001b[38;5;75m`.
const JSON_COLOR_CODE = /\\u001b\[[0-9;]*m/g;

/** Removes the terminal color codes from the log lines: they are only useful in the console. */
function withoutColors(stream: DestinationStream): DestinationStream {
	return { write: (line: string) => stream.write(line.replace(JSON_COLOR_CODE, '')) };
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
