import 'reflect-metadata';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { statsResponseSchema } from '@band-spider/contracts';
import { BandDatabase } from '@band-spider/storage-sqlite';
import { startDbService } from '../index';

describe('GET /stats queue numbers', () => {
	it('has the number of URLs that wait to be claimed', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'band-spider-service-queue-'));
		const file = path.join(dir, 'queue.sqlite');
		const service = await startDbService({ host: '127.0.0.1', port: 0, database: { file, synchronize: true } });
		const seed = await BandDatabase.open({ file, synchronize: false });
		try {
			await seed.item.insert('https://sq.bandcamp.com/track/1');
			await seed.item.insert('https://sq.bandcamp.com/track/2');
			await seed.account.insert('https://bandcamp.com/sq-one');

			const stats = statsResponseSchema.parse(await (await fetch(service.url + '/stats')).json());
			assert.deepEqual(stats.queueLeft, { items: 2, accounts: 1 });

			const response = await fetch(service.url + '/claim', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ type: 'item', count: 1, newestFirst: false }),
			});
			assert.equal((await response.json() as { tasks: unknown[] }).tasks.length, 1);

			const after = statsResponseSchema.parse(await (await fetch(service.url + '/stats')).json());
			assert.deepEqual(after.queueLeft, { items: 1, accounts: 1 });
			assert.equal(after.claimed, 1);
		} finally {
			await seed.close();
			await service.stop();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
