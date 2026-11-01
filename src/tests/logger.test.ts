import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import clc from 'cli-color';
import { LOG_FILE, logger, logToFile, urlColor } from '../common/logger';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'band-spider-log-'));
const file = path.join(dir, 'nested', 'test.log');

after(() => fs.rmSync(dir, { recursive: true, force: true }));

const readLines = (): any[] => fs.readFileSync(file, 'utf8').trim().split('\n').map(x => JSON.parse(x));

describe('logger', () => {
	it('uses logfile.log by default', () => {
		assert.equal(LOG_FILE, 'logfile.log');
	});

	it('does not write a file before logToFile', () => {
		logger.info('console only');
		assert.equal(fs.existsSync(file), false);
	});

	it('writes every level from debug up to the file as JSON lines', () => {
		logToFile(file);

		logger.debug('a debug line');
		logger.info('an info line');
		logger.warn('a warn line');
		logger.error(new Error('boom'), 'an error line');

		const lines = readLines();
		assert.deepEqual(lines.map(x => [x.level, x.msg]), [
			[20, 'a debug line'],
			[30, 'an info line'],
			[40, 'a warn line'],
			[50, 'an error line'],
		]);
		assert.equal(lines[3].err.message, 'boom');
		assert.match(lines[3].err.stack, /boom/);
	});

	it('adds to the end of an existing file', () => {
		logger.info('one more line');

		assert.equal(readLines().at(-1).msg, 'one more line');
		assert.equal(readLines().length, 5);
	});

	it('writes no terminal color codes to the file', () => {
		logger.info(`\t📀 ${urlColor('https://band.bandcamp.com/track/a')} ${clc.xterm(215)('1/2')}`);

		assert.equal(readLines().at(-1).msg, '\t📀 https://band.bandcamp.com/track/a 1/2');
		assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /u001b|38;5;/);
	});
});
