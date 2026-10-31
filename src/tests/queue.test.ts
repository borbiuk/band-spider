import assert from 'node:assert/strict';
import { beforeEach, describe, it, mock } from 'node:test';
import { ProcessingQueue } from '../common/processing-queue';
import { UrlType } from '../core/band-spider';
import { BandDatabase } from '../data/db';

type Row = { id: number, isBusy: boolean };

/** Only what the queue uses. `rows` decides what `insert` returns for a URL. */
const createDatabase = (rows: Record<string, Row | null> = {}) => {
	const calls: string[] = [];
	const insert = (table: string) => async (url: string) => {
		calls.push(`${table}.insert ${url}`);
		return { entity: url in rows ? rows[url] : { id: 1, isBusy: false }, isInserted: false };
	};
	const removeByUrl = (table: string) => async (url: string) => { calls.push(`${table}.removeByUrl ${url}`); };
	const database = {
		item: { insert: insert('item'), removeByUrl: removeByUrl('item') },
		account: { insert: insert('account'), removeByUrl: removeByUrl('account') },
	} as unknown as BandDatabase;
	return { database, calls };
};

const album = (n: number) => `https://band.bandcamp.com/album/a${n}`;
const fan = 'https://bandcamp.com/fan';

describe('ProcessingQueue', () => {
	beforeEach(() => {
		mock.restoreAll();
		// always take the first URL, so the order is known
		mock.method(Math, 'random', () => 0);
	});

	it('keeps the UrlType values', () => {
		assert.equal(UrlType.Account, 'account');
		assert.equal(UrlType.Item, 'item');
	});

	it('drops duplicates of the start list', () => {
		const queue = new ProcessingQueue([album(1), album(2), album(1)], createDatabase().database);
		assert.equal(queue.size, 2);
	});

	it('enqueue strips the query, accepts item and account URLs only, and skips known URLs', () => {
		const queue = new ProcessingQueue([], createDatabase().database);

		assert.equal(queue.enqueue(album(1) + '?from=x'), true);
		assert.equal(queue.enqueue(album(1)), false, 'same URL without the query');
		assert.equal(queue.enqueue(fan + '?a=1'), true);
		assert.equal(queue.enqueue('https://band.bandcamp.com/'), false, 'not an item and not an account');
		assert.equal(queue.enqueue('not a url'), false);
		assert.equal(queue.size, 2);
	});

	it('has a default capacity of 500', () => {
		const queue = new ProcessingQueue([], createDatabase().database);

		for (let i = 0; i < 500; i++) {
			assert.equal(queue.enqueue(album(i)), true);
		}
		assert.equal(queue.enqueue(album(500)), false);
		assert.equal(queue.size, 500);
	});

	it('enqueueButch is refused only when the queue is already full', () => {
		const queue = new ProcessingQueue([], createDatabase().database, 3);

		assert.equal(queue.enqueueButch([album(1), 'bad', album(2), album(3), album(4)]), true);
		assert.equal(queue.size, 3, 'stops adding at the capacity');
		assert.equal(queue.enqueueButch([album(5)]), false);
	});

	it('dequeue returns null for an empty queue', async () => {
		assert.equal(await new ProcessingQueue([], createDatabase().database).dequeue(), null);
	});

	it('dequeue inserts an item URL and returns an item event', async () => {
		const { database, calls } = createDatabase({ [album(1)]: { id: 11, isBusy: false } });
		const queue = new ProcessingQueue([album(1), fan], database);

		assert.deepEqual(await queue.dequeue(), { id: 11, url: album(1), type: UrlType.Item });
		assert.deepEqual(calls, [`item.insert ${album(1)}`]);
		assert.equal(queue.size, 1);
		assert.equal(queue.enqueue(album(1)), true, 'a taken URL can be queued again');
	});

	it('dequeue returns an account event for an account URL', async () => {
		const { database } = createDatabase({ [fan]: { id: 5, isBusy: false } });
		const queue = new ProcessingQueue([fan], database);

		assert.deepEqual(await queue.dequeue(), { id: 5, url: fan, type: UrlType.Account });
	});

	it('puts a busy URL back and returns null', async () => {
		const { database } = createDatabase({ [album(1)]: { id: 1, isBusy: true }, [fan]: { id: 2, isBusy: true } });
		const queue = new ProcessingQueue([album(1), fan], database);

		assert.equal(await queue.dequeue(), null);
		assert.equal(await queue.dequeue(), null);
		assert.equal(queue.size, 2);
		assert.equal(queue.enqueue(album(1)), false, 'still known');
	});

	it('drops an account URL when insert gives no row', async () => {
		const { database } = createDatabase({ [fan]: null });
		const queue = new ProcessingQueue([fan], database);

		assert.equal(await queue.dequeue(), null);
		assert.equal(queue.size, 0);
	});

	it('removes a URL of unknown type from both tables', async () => {
		const bad = 'https://band.bandcamp.com/';
		const { database, calls } = createDatabase();
		const queue = new ProcessingQueue([bad], database);

		assert.equal(await queue.dequeue(), null);
		assert.deepEqual(calls, [`account.removeByUrl ${bad}`, `item.removeByUrl ${bad}`]);
		assert.equal(queue.size, 0);
	});

	it('takes a random URL', async () => {
		mock.method(Math, 'random', () => 0.99);
		const queue = new ProcessingQueue([album(1), album(2), album(3)], createDatabase().database);

		assert.equal((await queue.dequeue()).url, album(3));
	});
});
