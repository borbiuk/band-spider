import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { NotFoundGuard, NotFoundVerdict } from '../common/not-found-guard';

const guard = () => new NotFoundGuard({ windowSize: 10, minSamples: 5, maxShare: 0.3 });

describe('NotFoundGuard', () => {
	it('does not trust a 404 before enough answers are known', () => {
		const g = guard();
		g.reportPage();
		g.reportPage();
		g.reportPage();
		assert.equal(g.reportNotFound(), NotFoundVerdict.Unknown);
	});

	it('trusts a rare 404', () => {
		const g = guard();
		for (let i = 0; i < 9; i++) {
			g.reportPage();
		}
		assert.equal(g.reportNotFound(), NotFoundVerdict.Trusted);
	});

	it('sees a burst of 404s as a block', () => {
		const g = guard();
		for (let i = 0; i < 6; i++) {
			g.reportPage();
		}
		g.reportNotFound();
		g.reportNotFound();
		assert.equal(g.reportNotFound(), NotFoundVerdict.Burst);
	});

	it('trusts a 404 again when old 404s leave the window', () => {
		const g = guard();
		for (let i = 0; i < 5; i++) {
			g.reportNotFound();
		}
		for (let i = 0; i < 9; i++) {
			g.reportPage();
		}
		// the window holds 9 pages and this 404
		assert.equal(g.reportNotFound(), NotFoundVerdict.Trusted);
	});

	it('uses the share of the window, not of all answers', () => {
		const g = guard();
		for (let i = 0; i < 100; i++) {
			g.reportPage();
		}
		for (let i = 0; i < 3; i++) {
			g.reportNotFound();
		}
		// 4 of the last 10 answers are 404
		assert.equal(g.reportNotFound(), NotFoundVerdict.Burst);
	});
});
