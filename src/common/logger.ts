const pino = require('pino');
const pretty = require('pino-pretty');

const stream = pretty({
	colorize: true,
	colorizeObjects: true,
	singleLine: true,
	ignore: 'pid,hostname',
});

export const logger = pino({ level: 'debug'}, stream);

export enum Source {
	Main =    '[🚨️ MAIN___]',
	Browser = '[🖥 BROWSER]',
	Page =    '[📄 PAGE___]',
	Account = '[💁 ACCOUNT]',
	Item =    '[📀 ITEM___]',
	Tag =     '[🏷 TAG____]',
}
