import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CrawlStore } from '@band-spider/core';
import { buildApp } from '../app';
import { readServiceConfig } from '../config';

/** A store whose claim waits until the test lets it go. */
const slowStore = (): { store: CrawlStore, release: () => void } => {
	let release = (): void => { };
	const gate = new Promise<void>(resolve => { release = resolve; });
	const store = { claim: async (): Promise<never[]> => { await gate; return []; } } as unknown as CrawlStore;
	return { store, release };
};

const claim = (app: ReturnType<typeof buildApp>) =>
	app.inject({ method: 'POST', url: '/claim', payload: { type: 'item', count: 1, newestFirst: false } });

describe('DB service overload', () => {
	it('answers 503 with Retry-After when too many write requests are open, but still answers /health', async () => {
		const { store, release } = slowStore();
		const app = buildApp({ store, maxOpenRequests: 2 });
		try {
			const first = claim(app);
			const second = claim(app);
			await new Promise(resolve => setImmediate(resolve));

			const refused = await claim(app);
			assert.equal(refused.statusCode, 503);
			assert.equal(refused.headers['retry-after'], '2');
			assert.deepEqual(refused.json(), { message: 'The DB service is busy' });
			assert.equal((await app.inject({ method: 'GET', url: '/health' })).statusCode, 200);

			release();
			assert.equal((await first).statusCode, 200);
			assert.equal((await second).statusCode, 200);

			// the slots are free again
			assert.equal((await claim(app)).statusCode, 200);
		} finally {
			release();
			await app.close();
		}
	});

	it('reads and checks DB_SERVICE_MAX_OPEN_REQUESTS', () => {
		assert.equal(readServiceConfig({}).maxOpenRequests, undefined);
		assert.equal(readServiceConfig({ DB_SERVICE_MAX_OPEN_REQUESTS: '50' }).maxOpenRequests, 50);
		assert.throws(() => readServiceConfig({ DB_SERVICE_MAX_OPEN_REQUESTS: '0' }), /DB_SERVICE_MAX_OPEN_REQUESTS/);
		assert.throws(() => readServiceConfig({ DB_SERVICE_MAX_OPEN_REQUESTS: 'many' }), /DB_SERVICE_MAX_OPEN_REQUESTS/);
	});
});
