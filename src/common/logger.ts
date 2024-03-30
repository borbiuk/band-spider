const pino = require('pino');
const pretty = require('pino-pretty');

const stream = pretty({
	colorize: true,
	levelFirst: true,
	colorizeObjects: true,
	singleLine: true,
	ignore: 'pid,hostname',
});

export const logger = pino({ level: 'debug' }, stream);
