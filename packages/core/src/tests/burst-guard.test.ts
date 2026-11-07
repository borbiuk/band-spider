import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BurstGuard, BurstVerdict } from '../common/burst-guard';

const guard = () => new BurstGuard({ windowSize: 10, minSamples: 5, maxShare: 0.3 });

describe('BurstGuard', () => {
	it('does not trust a suspect answer before enough answers are known', () => {
		const g = guard();
		g.reportOk();
		g.reportOk();
		g.reportOk();
		assert.equal(g.reportSuspect(), BurstVerdict.Unknown);
	});

	it('trusts a rare suspect answer', () => {
		const g = guard();
		for (let i = 0; i < 9; i++) {
			g.reportOk();
		}
		assert.equal(g.reportSuspect(), BurstVerdict.Trusted);
	});

	it('sees a burst of suspect answers', () => {
		const g = guard();
		for (let i = 0; i < 6; i++) {
			g.reportOk();
		}
		g.reportSuspect();
		g.reportSuspect();
		assert.equal(g.reportSuspect(), BurstVerdict.Burst);
	});

	it('trusts again when old suspect answers leave the window', () => {
		const g = guard();
		for (let i = 0; i < 5; i++) {
			g.reportSuspect();
		}
		for (let i = 0; i < 9; i++) {
			g.reportOk();
		}
		// the window holds 9 pages and this suspect answer
		assert.equal(g.reportSuspect(), BurstVerdict.Trusted);
	});

	it('uses the share of the window, not of all answers', () => {
		const g = guard();
		for (let i = 0; i < 100; i++) {
			g.reportOk();
		}
		for (let i = 0; i < 3; i++) {
			g.reportSuspect();
		}
		// 4 of the last 10 answers are suspect
		assert.equal(g.reportSuspect(), BurstVerdict.Burst);
	});
});
