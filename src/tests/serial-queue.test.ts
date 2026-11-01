import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SerialQueue } from '../common/serial-queue';

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('SerialQueue', () => {
	it('runs jobs one at a time in the order they were added', async () => {
		const queue = new SerialQueue();
		const events: string[] = [];
		const job = (name: string, ms: number) => queue.run(async () => {
			events.push(`start ${name}`);
			await pause(ms);
			events.push(`end ${name}`);
			return name;
		});

		const results = await Promise.all([job('a', 20), job('b', 1), job('c', 1)]);

		assert.deepEqual(results, ['a', 'b', 'c']);
		assert.deepEqual(events, ['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
	});

	it('goes on after a failed job and gives the error to its caller', async () => {
		const queue = new SerialQueue();
		const failed = queue.run(async () => { throw new Error('boom'); });
		const next = queue.run(async () => 'ok');

		await assert.rejects(failed, /boom/);
		assert.equal(await next, 'ok');
	});
});
