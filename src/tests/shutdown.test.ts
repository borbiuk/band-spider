import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { SIGNAL_EXIT_CODES, stopOnSignals } from '../common/shutdown';

describe('stopOnSignals', () => {
	const listeners = { SIGINT: process.listenerCount('SIGINT'), SIGTERM: process.listenerCount('SIGTERM') };

	afterEach(() => {
		// the signals below are only emitted, never sent; the test process must still exit with 0
		process.removeAllListeners('SIGINT');
		process.removeAllListeners('SIGTERM');
		process.exitCode = undefined;
		mock.restoreAll();
	});

	it('uses the shell exit codes', () => {
		assert.deepEqual(SIGNAL_EXIT_CODES, { SIGINT: 130, SIGTERM: 143 });
	});

	for (const [name, code] of Object.entries(SIGNAL_EXIT_CODES)) {
		it(`aborts on the first ${name} and sets exit code ${code}`, () => {
			const exit = mock.method(process, 'exit', () => undefined as never);
			const stop = stopOnSignals();
			assert.equal(stop.aborted, false);
			assert.equal(process.listenerCount('SIGINT'), listeners.SIGINT + 1);
			assert.equal(process.listenerCount('SIGTERM'), listeners.SIGTERM + 1);

			process.emit(name as NodeJS.Signals);

			assert.equal(stop.aborted, true);
			assert.equal(process.exitCode, code);
			assert.equal(exit.mock.callCount(), 0, 'the first signal does not exit');
		});
	}

	it('exits at once on a second signal of either kind', () => {
		for (const [first, second] of [['SIGINT', 'SIGINT'], ['SIGINT', 'SIGTERM'], ['SIGTERM', 'SIGINT']]) {
			const exit = mock.method(process, 'exit', () => undefined as never);
			stopOnSignals();

			process.emit(first as NodeJS.Signals);
			process.emit(second as NodeJS.Signals);

			assert.equal(exit.mock.callCount(), 1, `${first} then ${second}`);
			process.removeAllListeners('SIGINT');
			process.removeAllListeners('SIGTERM');
			mock.restoreAll();
		}
	});
});
