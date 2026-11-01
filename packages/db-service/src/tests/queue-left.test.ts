import 'reflect-metadata';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { statsResponseSchema, totalsResponseSchema } from '@band-spider/contracts';
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

			// the counted size is reused for a minute, because counting a big DB blocks the service
			const after = statsResponseSchema.parse(await (await fetch(service.url + '/stats')).json());
			assert.deepEqual(after.queueLeft, { items: 2, accounts: 1 });
			assert.equal(after.claimed, 1);
		} finally {
			await seed.close();
			await service.stop();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('GET /totals and the flow counters of /stats', () => {
	it('counts the rows of the DB and what the saved pages added', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'band-spider-service-totals-'));
		const file = path.join(dir, 'totals.sqlite');
		const service = await startDbService({ host: '127.0.0.1', port: 0, database: { file, synchronize: true } });
		const seed = await BandDatabase.open({ file, synchronize: false });
		try {
			await seed.item.insert('https://st.bandcamp.com/track/1');
			await seed.account.insert('https://bandcamp.com/st-one');

			const totals = totalsResponseSchema.parse(await (await fetch(service.url + '/totals')).json());
			assert.equal(totals.items, 1);
			assert.equal(totals.accounts, 1);
			assert.equal(totals.itemAccountRelations, 0);

			// no page is saved yet, so every counter of the flow is zero
			const stats = statsResponseSchema.parse(await (await fetch(service.url + '/stats')).json());
			assert.equal(stats.flow?.itemPages.saved, 0);
			assert.deepEqual(stats.flow?.accountPages.wishlist, { total: 0, newRecords: 0, newRelations: 0 });
		} finally {
			await seed.close();
			await service.stop();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
