import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

// tests run from `packages/cli/dist/tests`, the root package.json is four levels up
const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../../package.json'), 'utf8'));
const scripts: Record<string, string> = packageJson.scripts;

const KNOWN_FLAGS = ['--account', '--superTag', '--reverse'];

/** Flags passed to the app by every script that runs it. */
const APP_RUNS: Record<string, string[]> = {
	'db:accounts': ['--account'],
	'db:items': [],
	'db:accounts:reverse': ['--account', '--reverse'],
	'db:items:reverse': ['--reverse'],
	'superTag': ['--superTag'],
};

describe('npm scripts', () => {
	it('keeps the script names', () => {
		assert.deepEqual(Object.keys(scripts).sort(), [
			...Object.keys(APP_RUNS),
			'build',
			'db:service',
			'crawler:items',
			'crawler:accounts',
			'test',
		].sort());
	});

	for (const [name, flags] of Object.entries(APP_RUNS)) {
		it(`"${name}" builds and runs the app with ${flags.join(' ')}`, () => {
			const [build, run] = scripts[name].split(' && ');
			assert.equal(build, 'npm run build');
			assert.ok(run.startsWith('node ./packages/cli/dist/index.js'), run);

			const used = run.split(/\s+/).filter(x => x.startsWith('--'));
			assert.deepEqual(used, flags);
			assert.ok(used.every(x => KNOWN_FLAGS.includes(x)));
		});
	}
});
