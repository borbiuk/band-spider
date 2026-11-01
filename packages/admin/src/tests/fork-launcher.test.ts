import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { ForkLauncher } from '../process-launcher';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'band-spider-fork-'));
after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

describe('ForkLauncher', () => {
	it('forks a script, passes env, relays IPC messages and output, and reports the exit', async () => {
		const script = path.join(tempDir, 'child.js');
		fs.writeFileSync(script, `
			console.log('hello ' + process.env.TEST_VALUE + ' ' + (process.env.TEST_REMOVED === undefined));
			process.send({ type: 'ready' });
			process.on('message', message => {
				if (message.type === 'stop') {
					process.exit(7);
				}
			});
		`);
		process.env.TEST_REMOVED = 'yes';
		const handle = new ForkLauncher().launch({ entry: script, env: { TEST_VALUE: 'x', TEST_REMOVED: undefined } });

		let output = '';
		handle.onOutput((_stream, text) => output += text);
		const ready = new Promise<unknown>(resolve => handle.onMessage(resolve));
		const exit = new Promise<{ code: number | null }>(resolve => handle.onExit(resolve));

		assert.deepEqual(await ready, { type: 'ready' });
		handle.send({ type: 'stop' });
		assert.equal((await exit).code, 7);
		assert.equal(output.trim(), 'hello x true');
		delete process.env.TEST_REMOVED;
	});

	it('kills a child with a signal', async () => {
		const script = path.join(tempDir, 'hang.js');
		fs.writeFileSync(script, 'process.send({ type: "ready" }); setInterval(() => {}, 1000);');
		const handle = new ForkLauncher().launch({ entry: script });
		const ready = new Promise(resolve => handle.onMessage(resolve));
		const exit = new Promise<{ signal: string | null }>(resolve => handle.onExit(resolve));
		await ready;
		handle.kill('SIGTERM');
		assert.equal((await exit).signal, 'SIGTERM');
	});
});
