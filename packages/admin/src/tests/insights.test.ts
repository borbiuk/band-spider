import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { FlowStats } from '@band-spider/contracts';
import { DbStats, DbTotals } from '../db-stats';
import { computeInsights, flowRate, flowSample, flowSeries, FlowSample, longDurationText } from '../insights';
import { CrawlerStatus, InsightsSnapshot } from '../supervisor';
import { renderInsights } from '../ui-insights';

const MIN = 60_000;
const NOW = 10_000_000;

const tab = (total: number, newRecords: number, newRelations: number) => ({ total, newRecords, newRelations });

const FLOW: FlowStats = {
	itemPages: { saved: 10, accounts: tab(100, 40, 100), tags: tab(50, 5, 50), album: tab(2, 1, 1), tracks: tab(8, 4, 4) },
	accountPages: {
		saved: 20,
		collection: tab(400, 80, 300),
		wishlist: tab(100, 30, 100),
		followers: tab(20, 2, 20),
		following: tab(30, 1, 30),
	},
};

const STATS: DbStats = {
	startedAt: new Date(NOW - 60 * MIN),
	claimed: 40, itemsSaved: 10, accountsSaved: 20, released: 10, newUrls: 300,
	queueLeft: { items: 900, accounts: 100 },
	flow: FLOW,
};

const TOTALS: DbTotals = {
	countedAt: new Date(NOW), items: 1000, itemsProcessed: 250, accounts: 500, accountsProcessed: 100,
	itemAccountRelations: 2000, wishlistRelations: 500, followers: 40,
};

const sample = (minutesAgo: number, values: Partial<FlowSample>): FlowSample =>
	({ at: NOW - minutesAgo * MIN, pages: 0, newUrls: 0, items: 0, accounts: 0, links: 0, ...values });

describe('flow history', () => {
	it('sums the flow of the DB service into one sample', () => {
		const result = flowSample(NOW, STATS);
		// new items: album 1 + tracks 4 + collection 80 + wishlist 30
		assert.deepEqual(result, { at: NOW, pages: 30, newUrls: 300, items: 115, accounts: 43, links: 500 });
		assert.equal(flowSample(NOW, { ...STATS, flow: undefined }), undefined);
	});

	it('gives the gain of each of the last minutes', () => {
		const history = [sample(3, { items: 0 }), sample(2, { items: 10 }), sample(1, { items: 40 }), sample(0, { items: 40 })];
		const series = flowSeries(history, 'items', NOW);
		assert.equal(series.length, 15);
		assert.deepEqual(series.slice(-4), [0, 10, 30, 0]);
		assert.equal(series.slice(0, 11).every(value => value === 0), true);
		assert.deepEqual(flowSeries([sample(0, {})], 'items', NOW), []);
	});

	it('counts a speed per minute over the last five minutes', () => {
		const history = [sample(10, { pages: 0 }), sample(5, { pages: 50 }), sample(0, { pages: 100 })];
		assert.equal(flowRate(history, 'pages'), 10);
		assert.equal(flowRate([sample(0, {})], 'pages'), undefined);
	});
});

describe('computeInsights', () => {
	const crawler = (name: string, requests: number, processed: number, failed: number): CrawlerStatus => ({
		name, configured: true, state: 'running',
		stats: {
			requestsPerMin: 1, urlsPerMin: 1, http429PerHour: 2,
			totals: { requests, processed, failed, http429: 1 }, pauseMs: 0, idle: false,
		},
	});

	const input = (extra = {}) => ({
		stats: STATS, totals: TOTALS, crawlers: [crawler('a', 200, 90, 10)], now: NOW,
		history: [sample(5, { pages: 0, newUrls: 0 }), sample(0, { pages: 50, newUrls: 100 })],
		...extra,
	});

	it('counts what was added and how much of each source is new', () => {
		const insights = computeInsights(input());
		assert.deepEqual(insights.added, {
			items: 115, accounts: 43, links: 500, follows: 50, collectionLinks: 300, wishlistLinks: 100, tagLinks: 50,
		});
		assert.deepEqual(insights.pages, { items: 10, accounts: 20, total: 30 });
		const collection = insights.novelty.find(row => row.label.includes('collection'));
		assert.deepEqual(collection, { label: 'Account pages: collection (items)', total: 400, fresh: 80, percent: 20 });
		// (115 + 43) / 30 pages
		assert.equal(insights.yield.newRecordsPerPage, 5.27);
		assert.equal(insights.wishlistShareNew, 25);
	});

	it('shows the collection and wishlist split and the coverage of the DB', () => {
		const { db } = computeInsights(input());
		assert.equal(db?.collectionLinks, 1500);
		assert.equal(db?.wishlistShare, 25);
		assert.equal(db?.itemsCoverage, 25);
		assert.equal(db?.accountsCoverage, 20);
		assert.equal(db?.linksPerAccount, 4);
		assert.equal(computeInsights(input({ totals: undefined })).db, undefined);
	});

	it('says when the queue is empty in the end, or that it grows', () => {
		// 10 pages a minute are saved, 20 new URLs are found: the queue grows
		const growing = computeInsights(input());
		assert.equal(growing.queue.growing, true);
		assert.equal(growing.queue.etaMs, undefined);
		assert.match(growing.takeaways.map(item => item.text).join('\n'), /queue grows/);

		// 10 pages a minute, 5 found: 1000 left shrinks by 5 a minute, 200 minutes
		const shrinking = computeInsights(input({ history: [sample(5, {}), sample(0, { pages: 50, newUrls: 25 })] }));
		assert.equal(shrinking.queue.growing, false);
		assert.equal(Math.round((shrinking.queue.etaMs ?? 0) / MIN), 200);
		assert.match(shrinking.takeaways.map(item => item.text).join('\n'), /empty in about 3h 20m/);
	});

	it('warns about a low share of new records, many 429 answers and many given back URLs', () => {
		const flat: FlowStats = {
			itemPages: { saved: 1, accounts: tab(1000, 10, 0), tags: tab(0, 0, 0), album: tab(0, 0, 0), tracks: tab(0, 0, 0) },
			accountPages: { saved: 0, collection: tab(0, 0, 0), wishlist: tab(0, 0, 0), followers: tab(0, 0, 0), following: tab(0, 0, 0) },
		};
		const crawlers = [{ ...crawler('a', 10, 1, 0), stats: { ...crawler('a', 10, 1, 0).stats!, http429PerHour: 90 } }];
		const insights = computeInsights(input({ stats: { ...STATS, flow: flat }, crawlers }));
		const text = insights.takeaways.map(item => `${item.tone}: ${item.text}`).join('\n');
		assert.match(text, /warn: Only 1% of the records/);
		assert.match(text, /bad: 90 HTTP 429/);
		assert.match(text, /warn: 25% of the taken URLs/);
	});

	it('has one note and no numbers before a page is saved, and works without a DB service flow', () => {
		const empty: FlowStats = {
			itemPages: { saved: 0, accounts: tab(0, 0, 0), tags: tab(0, 0, 0), album: tab(0, 0, 0), tracks: tab(0, 0, 0) },
			accountPages: { saved: 0, collection: tab(0, 0, 0), wishlist: tab(0, 0, 0), followers: tab(0, 0, 0), following: tab(0, 0, 0) },
		};
		const none = computeInsights(input({ stats: { ...STATS, flow: empty } }));
		assert.equal(none.takeaways.length, 1);
		assert.equal(none.yield.newRecordsPerPage, undefined);
		assert.equal(computeInsights({ crawlers: [], history: [], now: NOW }).pages.total, 0);
	});

	it('writes a long time as a short text', () => {
		assert.equal(longDurationText(20_000), 'under a minute');
		assert.equal(longDurationText(5 * MIN), '5m');
		assert.equal(longDurationText(200 * MIN), '3h 20m');
		assert.equal(longDurationText(52 * 60 * MIN), '2d 4h');
	});
});

describe('renderInsights', () => {
	const snapshot = (extra: Partial<InsightsSnapshot> = {}): InsightsSnapshot => ({
		db: { state: 'running', dbStats: STATS },
		crawlers: [],
		history: [sample(2, { items: 0 }), sample(0, { items: 30, pages: 5 })],
		totals: TOTALS,
		totalsLoading: false,
		...extra,
	});

	it('shows the numbers and the charts with attributes only, because the page CSP has no inline styles', () => {
		const html = renderInsights(snapshot(), NOW);
		assert.match(html, /Database insights/);
		assert.match(html, /<svg class="chart"/);
		assert.match(html, /<svg class="bar bar-low"/);
		assert.match(html, /collection <b>1,500<\/b> · wishlist <b>500<\/b> \(25%\)/);
		// the blue part is the collection: 1500 of 2000 links in the DB
		assert.match(html, /<rect class="bar-coll" width="75"/);
		assert.match(html, /hx-get="\/fragments\/insights-close"/);
		assert.doesNotMatch(html, /\sstyle=/);
	});

	it('says that the DB size is being counted, or why it failed', () => {
		assert.match(renderInsights(snapshot({ totals: undefined, totalsLoading: true }), NOW), /Counting the rows of the DB/);
		assert.match(renderInsights(snapshot({ totals: undefined, totalsError: 'timed out <b>' }), NOW), /DB size: timed out &lt;b&gt;/);
	});

	it('says that there is nothing to show while the DB service is stopped', () => {
		const html = renderInsights(snapshot({ db: { state: 'stopped' } }), NOW);
		assert.match(html, /DB service is not running/);
		assert.doesNotMatch(html, /<svg/);
	});
});
