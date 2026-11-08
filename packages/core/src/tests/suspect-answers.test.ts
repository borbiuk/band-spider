import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SuspectAnswers } from '../common/suspect-answers';

const create = () => {
	const clock = { now: 1_000_000 };
	const answers = new SuspectAnswers<string>({
		confirmWindowMs: 1000,
		rules: { notFound: { minCount: 3, minShare: 0.1 }, connection: { minCount: 1, minShare: 0.05 } },
		now: () => clock.now,
	});
	return { answers, clock };
};

describe('SuspectAnswers', () => {
	it('confirms an answer with pages read shortly before and after it', () => {
		const { answers, clock } = create();
		answers.reportRead();
		clock.now += 100;
		answers.hold('gone', 'notFound');
		clock.now += 100;

		assert.deepEqual(answers.reportRead().map(x => x.item), ['gone']);
		assert.equal(answers.heldCount, 0);
	});

	it('does not confirm an answer with no page read before it', () => {
		const { answers, clock } = create();
		answers.hold('gone', 'notFound');
		clock.now += 100;

		assert.deepEqual(answers.reportRead(), []);
		assert.equal(answers.heldCount, 1);
	});

	it('does not confirm an answer when the page after it comes too late', () => {
		const { answers, clock } = create();
		answers.reportRead();
		answers.hold('gone', 'notFound');
		clock.now += 1001;

		assert.deepEqual(answers.reportRead(), []);
	});

	it('makes a control request due when an answer waits longer than the window', () => {
		const { answers, clock } = create();
		answers.hold('gone', 'notFound');
		assert.equal(answers.checkDue(), undefined);

		clock.now += 1001;
		assert.equal(answers.checkDue(), 'notFound');
	});

	it('makes a control request due when one kind is too frequent', () => {
		const { answers } = create();
		for (let i = 0; i < 6; i++) {
			answers.reportRead();
		}
		answers.hold('a', 'connection');
		assert.equal(answers.checkDue(), undefined, 'one network error is not more than the count of 1');

		answers.hold('b', 'connection');
		assert.equal(answers.checkDue(), 'connection');
	});

	it('needs both the count and the share', () => {
		const { answers } = create();
		for (let i = 0; i < 100; i++) {
			answers.reportRead();
		}
		for (let i = 0; i < 4; i++) {
			answers.hold(`gone-${i}`, 'notFound');
			answers.reportRead();
		}
		// 4 of 104 answers is less than 10%
		assert.equal(answers.checkDue(), undefined);
	});

	it('gives all held answers and starts the counts again', () => {
		const { answers } = create();
		answers.hold('a', 'notFound');
		answers.hold('b', 'connection');
		answers.hold('c', 'connection');
		assert.equal(answers.oldestKind, 'notFound');

		assert.deepEqual(answers.takeAll().map(x => x.item), ['a', 'b', 'c']);
		assert.equal(answers.heldCount, 0);
		assert.equal(answers.checkDue(), undefined);
		assert.equal(answers.oldestKind, undefined);
	});
});
