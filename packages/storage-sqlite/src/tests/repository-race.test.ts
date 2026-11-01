import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EntityManager } from 'typeorm';
import { AccountRepository } from '../repositories/account-repository';
import { ItemRepository } from '../repositories/item-repository';
import { SuperTagRepository } from '../repositories/super-tag-repository';
import { TagRepository } from '../repositories/tag-repository';

/**
 * A manager whose repositories act as if another writer inserted the row between the lookup and
 * the insert: the first lookup finds nothing, the insert fails on the unique key, the second
 * lookup finds the row.
 */
const raceManager = (existing: object): { manager: EntityManager, calls: string[] } => {
	const calls: string[] = [];
	let lookups = 0;
	const repository = {
		findOne: async () => {
			calls.push('findOne');
			return lookups++ === 0 ? null : existing;
		},
		insert: async () => {
			calls.push('insert');
			throw new Error('UNIQUE constraint failed');
		},
		save: async () => { calls.push('save'); },
	};
	return { manager: { getRepository: () => repository } as unknown as EntityManager, calls };
};

/** A manager whose repositories fail the insert and find nothing afterwards either. */
const failingManager = (): EntityManager => ({
	getRepository: () => ({
		findOne: async (): Promise<null> => null,
		insert: async () => { throw new Error('disk I/O error'); },
	}),
} as unknown as EntityManager);

describe('insert after a lost race', () => {
	it('account.insert returns the row of the other writer', async () => {
		const row = { id: 7, url: 'https://bandcamp.com/fan', isBusy: false, failedCount: 0 };
		const { manager, calls } = raceManager(row);

		assert.deepEqual(await new AccountRepository(manager).insert(row.url), { entity: row, isInserted: false });
		assert.deepEqual(calls, ['findOne', 'insert', 'findOne']);
	});

	it('item.insert returns the row of the other writer', async () => {
		const row = { id: 8, url: 'https://band.bandcamp.com/track/x' };
		const { manager } = raceManager(row);

		assert.deepEqual(await new ItemRepository(manager).insert(row.url), { entity: row, isInserted: false });
	});

	it('tag.insert returns the row of the other writer', async () => {
		const row = { id: 9, name: 'techno' };
		const { manager } = raceManager(row);

		assert.deepEqual(await new TagRepository(manager).insert('Techno'), { entity: row, isInserted: false });
	});

	it('keeps the answer of each relation method', async () => {
		const answer = async (call: (manager: EntityManager) => Promise<boolean>) => {
			const { manager, calls } = raceManager({ wishlist: false });
			const result = await call(manager);
			assert.deepEqual(calls, ['findOne', 'insert', 'findOne'], 'no save after a lost race');
			return result;
		};

		assert.equal(await answer(m => new AccountRepository(m).addItem(1, 2, true)), true);
		assert.equal(await answer(m => new AccountRepository(m).addFollower(1, 2)), true);
		assert.equal(await answer(m => new TagRepository(m).addItem(1, 2)), false);
		assert.equal(await answer(m => new SuperTagRepository(m).addTag(1, 2)), false);
	});

	it('throws the insert error when the row is still missing', async () => {
		await assert.rejects(new AccountRepository(failingManager()).insert('https://bandcamp.com/x'), { message: 'disk I/O error' });
		await assert.rejects(new ItemRepository(failingManager()).insert('https://band.bandcamp.com/track/x'), { message: 'disk I/O error' });
		await assert.rejects(new AccountRepository(failingManager()).addFollower(1, 2), { message: 'disk I/O error' });
		await assert.rejects(new TagRepository(failingManager()).addItem(1, 2), { message: 'disk I/O error' });
	});
});
