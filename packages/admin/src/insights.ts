import type { FlowStats } from '@band-spider/contracts';
import type { DbStats, DbTotals } from './db-stats';
import type { CrawlerStatus } from './supervisor';

/** The counters of the DB service flow at one moment, summed for the charts. All numbers grow from the start of the service. */
export interface FlowSample {
	/** Time in ms since 1970. */
	at: number;
	/** Saved pages, items and accounts together. */
	pages: number;
	/** URLs that were new in the DB and joined the queue. */
	newUrls: number;
	/** New item records. */
	items: number;
	/** New account records. */
	accounts: number;
	/** New links between an item and an account. */
	links: number;
}

export type FlowField = Exclude<keyof FlowSample, 'at'>;

/** The one-minute buckets of a chart. */
export const FLOW_BUCKETS = 15;
export const FLOW_BUCKET_MS = 60_000;

/** A speed is counted over this time. */
const RATE_WINDOW_MS = 5 * 60_000;
/** Below this share of new records the pages give little more. */
const LOW_NOVELTY_PERCENT = 5;
const HIGH_NOVELTY_PERCENT = 30;
/** A source needs this many records before it can be called the best or the worst. */
const MIN_RECORDS_FOR_RANKING = 20;
const HIGH_RELEASED_PERCENT = 20;
const HIGH_429_PER_HOUR = 60;

/** The sums of the flow of the DB service. */
export const flowSums = (flow: FlowStats) => {
	const { itemPages, accountPages } = flow;
	return {
		itemPagesSaved: itemPages.saved,
		accountPagesSaved: accountPages.saved,
		pages: itemPages.saved + accountPages.saved,
		items: itemPages.album.newRecords + itemPages.tracks.newRecords + accountPages.collection.newRecords + accountPages.wishlist.newRecords,
		accounts: itemPages.accounts.newRecords + accountPages.followers.newRecords + accountPages.following.newRecords,
		links: itemPages.accounts.newRelations + accountPages.collection.newRelations + accountPages.wishlist.newRelations,
		collectionLinks: accountPages.collection.newRelations,
		wishlistLinks: accountPages.wishlist.newRelations,
		follows: accountPages.followers.newRelations + accountPages.following.newRelations,
		tagLinks: itemPages.tags.newRelations,
	};
};

/** One point of the history. Undefined for a DB service that does not count the flow. */
export const flowSample = (at: number, stats: DbStats): FlowSample | undefined => {
	if (!stats.flow) {
		return undefined;
	}
	const sums = flowSums(stats.flow);
	return { at, pages: sums.pages, newUrls: stats.newUrls, items: sums.items, accounts: sums.accounts, links: sums.links };
};

/** The value of a counter at a time: the newest sample that is not newer, or the oldest one. */
const valueAt = (history: FlowSample[], time: number, field: FlowField): number => {
	let value = history[0][field];
	for (const sample of history) {
		if (sample.at <= time) {
			value = sample[field];
		}
	}
	return value;
};

/** What a counter gained in each of the last minutes, oldest first. Empty without history. */
export const flowSeries = (history: FlowSample[], field: FlowField, now: number): number[] => {
	if (history.length < 2) {
		return [];
	}
	return Array.from({ length: FLOW_BUCKETS }, (_, i) => {
		const end = now - (FLOW_BUCKETS - 1 - i) * FLOW_BUCKET_MS;
		return Math.max(valueAt(history, end, field) - valueAt(history, end - FLOW_BUCKET_MS, field), 0);
	});
};

/** The speed of a counter per minute over the last five minutes. Undefined when the history is too short. */
export const flowRate = (history: FlowSample[], field: FlowField): number | undefined => {
	if (history.length < 2) {
		return undefined;
	}
	const last = history[history.length - 1];
	const base = history.find(sample => sample.at >= last.at - RATE_WINDOW_MS) ?? history[0];
	const minutes = (last.at - base.at) / 60_000;
	return minutes < 0.1 ? undefined : Math.max(last[field] - base[field], 0) / minutes;
};

const share = (part: number, whole: number): number | undefined =>
	whole > 0 ? Math.round((part / whole) * 1000) / 10 : undefined;

const ratio = (part: number, whole: number): number | undefined =>
	whole > 0 ? Math.round((part / whole) * 100) / 100 : undefined;

export interface NoveltyRow {
	label: string;
	/** Records on the pages. */
	total: number;
	/** The part of them that was new in the DB. */
	fresh: number;
	percent?: number;
}

export interface CrawlerRow {
	name: string;
	requests: number;
	saved: number;
	failed: number;
	http429PerHour: number;
	/** Saved pages for each request: low when requests are wasted on errors and pauses. */
	savedPerRequest?: number;
	failedPercent?: number;
}

export interface Takeaway {
	tone: 'ok' | 'warn' | 'bad' | 'info';
	text: string;
}

export interface Insights {
	/** Time since the DB service started, in ms. */
	sinceMs?: number;
	pages: { items: number; accounts: number; total: number };
	added: { items: number; accounts: number; links: number; follows: number; collectionLinks: number; wishlistLinks: number; tagLinks: number };
	perMinute: { pages?: number; items?: number; accounts?: number; links?: number; newUrls?: number };
	yield: { newRecordsPerPage?: number; linksPerPage?: number; newUrlsPerPage?: number };
	novelty: NoveltyRow[];
	/** The part of new item-account links that is a wishlist, from the account pages. */
	wishlistShareNew?: number;
	db?: {
		totals: DbTotals;
		collectionLinks: number;
		wishlistShare?: number;
		itemsCoverage?: number;
		accountsCoverage?: number;
		linksPerAccount?: number;
		linksPerItem?: number;
	};
	queue: { left?: number; discovered: number; consumed: number; net: number; etaMs?: number; growing: boolean };
	health: { releasedPercent?: number; failedPercent?: number; http429PerHour: number };
	crawlers: CrawlerRow[];
	takeaways: Takeaway[];
}

export interface InsightsInput {
	stats?: DbStats;
	totals?: DbTotals;
	history: FlowSample[];
	crawlers: CrawlerStatus[];
	now: number;
}

const noveltyRows = (flow: FlowStats): NoveltyRow[] => {
	const { itemPages, accountPages } = flow;
	const row = (label: string, ...tabs: Array<{ total: number; newRecords: number }>): NoveltyRow => {
		const total = tabs.reduce((sum, tab) => sum + tab.total, 0);
		const fresh = tabs.reduce((sum, tab) => sum + tab.newRecords, 0);
		return { label, total, fresh, percent: share(fresh, total) };
	};
	return [
		row('Account pages: collection (items)', accountPages.collection),
		row('Account pages: wishlist (items)', accountPages.wishlist),
		row('Account pages: followers (accounts)', accountPages.followers),
		row('Account pages: following (accounts)', accountPages.following),
		row('Item pages: collectors (accounts)', itemPages.accounts),
		row('Item pages: album and tracks (items)', itemPages.album, itemPages.tracks),
		row('Item pages: tags', itemPages.tags),
	];
};

const emptyInsights = (): Insights => ({
	pages: { items: 0, accounts: 0, total: 0 },
	added: { items: 0, accounts: 0, links: 0, follows: 0, collectionLinks: 0, wishlistLinks: 0, tagLinks: 0 },
	perMinute: {},
	yield: {},
	novelty: [],
	queue: { discovered: 0, consumed: 0, net: 0, growing: false },
	health: { http429PerHour: 0 },
	crawlers: [],
	takeaways: [],
});

/** Turns the counters, the DB size and the history into the numbers and the takeaways of the Insights view. */
export const computeInsights = ({ stats, totals, history, crawlers, now }: InsightsInput): Insights => {
	const result = emptyInsights();

	const rows: CrawlerRow[] = crawlers.filter(crawler => crawler.stats).map(crawler => {
		const t = crawler.stats!.totals;
		return {
			name: crawler.name,
			requests: t.requests,
			saved: t.processed,
			failed: t.failed,
			http429PerHour: crawler.stats!.http429PerHour,
			savedPerRequest: ratio(t.processed, t.requests),
			failedPercent: share(t.failed, t.processed + t.failed),
		};
	});
	result.crawlers = rows;
	result.health.http429PerHour = rows.reduce((sum, row) => sum + row.http429PerHour, 0);
	result.health.failedPercent = share(
		rows.reduce((sum, row) => sum + row.failed, 0),
		rows.reduce((sum, row) => sum + row.saved + row.failed, 0),
	);

	if (stats) {
		result.sinceMs = Math.max(now - stats.startedAt.getTime(), 0);
		result.health.releasedPercent = share(stats.released, stats.claimed);
		const consumed = stats.itemsSaved + stats.accountsSaved;
		result.queue = {
			left: stats.queueLeft ? stats.queueLeft.items + stats.queueLeft.accounts : undefined,
			discovered: stats.newUrls,
			consumed,
			net: stats.newUrls - consumed,
			growing: false,
		};
	}

	if (stats?.flow) {
		const sums = flowSums(stats.flow);
		result.pages = { items: sums.itemPagesSaved, accounts: sums.accountPagesSaved, total: sums.pages };
		result.added = {
			items: sums.items, accounts: sums.accounts, links: sums.links, follows: sums.follows,
			collectionLinks: sums.collectionLinks, wishlistLinks: sums.wishlistLinks, tagLinks: sums.tagLinks,
		};
		result.novelty = noveltyRows(stats.flow);
		result.wishlistShareNew = share(sums.wishlistLinks, sums.collectionLinks + sums.wishlistLinks);
		result.yield = {
			newRecordsPerPage: ratio(sums.items + sums.accounts, sums.pages),
			linksPerPage: ratio(sums.links + sums.follows, sums.pages),
			newUrlsPerPage: ratio(stats.newUrls, sums.pages),
		};
	}

	result.perMinute = {
		pages: flowRate(history, 'pages'),
		items: flowRate(history, 'items'),
		accounts: flowRate(history, 'accounts'),
		links: flowRate(history, 'links'),
		newUrls: flowRate(history, 'newUrls'),
	};

	// at this speed the queue shrinks by the pages that are processed minus the URLs that are found
	const { left } = result.queue;
	const { pages: pagesPerMin, newUrls: foundPerMin } = result.perMinute;
	if (left !== undefined && pagesPerMin !== undefined && pagesPerMin > 0) {
		const shrink = pagesPerMin - (foundPerMin ?? 0);
		if (shrink > 0) {
			result.queue.etaMs = (left / shrink) * 60_000;
		} else {
			result.queue.growing = true;
		}
	}

	if (totals) {
		const collectionLinks = totals.itemAccountRelations - totals.wishlistRelations;
		result.db = {
			totals,
			collectionLinks,
			wishlistShare: share(totals.wishlistRelations, totals.itemAccountRelations),
			itemsCoverage: share(totals.itemsProcessed, totals.items),
			accountsCoverage: share(totals.accountsProcessed, totals.accounts),
			linksPerAccount: ratio(totals.itemAccountRelations, totals.accounts),
			linksPerItem: ratio(totals.itemAccountRelations, totals.items),
		};
	}

	result.takeaways = takeaways(result);
	return result;
};

const percentText = (value: number): string => `${value}%`;

const takeaways = (insights: Insights): Takeaway[] => {
	const list: Takeaway[] = [];
	if (insights.pages.total === 0) {
		return [{ tone: 'info', text: 'No page is saved yet since the DB service started. The numbers appear after the first saves.' }];
	}

	const seen = insights.novelty.reduce((sum, row) => sum + row.total, 0);
	const fresh = insights.novelty.reduce((sum, row) => sum + row.fresh, 0);
	const overall = share(fresh, seen);
	if (overall !== undefined) {
		if (overall < LOW_NOVELTY_PERCENT) {
			list.push({ tone: 'warn', text: `Only ${percentText(overall)} of the records on the saved pages are new. The DB already has almost everything these pages show.` });
		} else if (overall >= HIGH_NOVELTY_PERCENT) {
			list.push({ tone: 'ok', text: `${percentText(overall)} of the records on the saved pages are new. The crawl still finds a lot.` });
		} else {
			list.push({ tone: 'info', text: `${percentText(overall)} of the records on the saved pages are new.` });
		}
	}

	const ranked = insights.novelty.filter(row => row.total >= MIN_RECORDS_FOR_RANKING && row.percent !== undefined)
		.sort((a, b) => b.percent! - a.percent!);
	if (ranked.length >= 2) {
		const best = ranked[0];
		const worst = ranked[ranked.length - 1];
		list.push({ tone: 'info', text: `Best source: ${best.label}, ${percentText(best.percent!)} new. Weakest: ${worst.label}, ${percentText(worst.percent!)} new.` });
	}

	const { queue } = insights;
	if (queue.growing) {
		list.push({
			tone: 'warn',
			text: `The queue grows: ${Math.round(insights.perMinute.newUrls ?? 0)} new URLs a minute are found, ${Math.round(insights.perMinute.pages ?? 0)} pages a minute are saved.`,
		});
	} else if (queue.etaMs !== undefined) {
		list.push({ tone: 'ok', text: `The queue shrinks. At this speed it is empty in about ${longDurationText(queue.etaMs)}.` });
	}

	if (insights.wishlistShareNew !== undefined) {
		const db = insights.db?.wishlistShare;
		list.push({
			tone: 'info',
			text: `Wishlist is ${percentText(insights.wishlistShareNew)} of the new links from account pages`
				+ (db !== undefined ? ` and ${percentText(db)} of all links in the DB.` : '.'),
		});
	}

	const { releasedPercent, failedPercent, http429PerHour } = insights.health;
	if (http429PerHour >= HIGH_429_PER_HOUR) {
		list.push({ tone: 'bad', text: `${http429PerHour} HTTP 429 answers an hour. The proxies are rate limited, slow the crawlers down or add proxies.` });
	}
	if (releasedPercent !== undefined && releasedPercent >= HIGH_RELEASED_PERCENT) {
		list.push({ tone: 'warn', text: `${percentText(releasedPercent)} of the taken URLs are given back without a save (errors, 429, not found).` });
	}
	if (failedPercent !== undefined && failedPercent > 0 && releasedPercent === undefined) {
		list.push({ tone: 'info', text: `${percentText(failedPercent)} of the processed pages failed.` });
	}

	if (insights.db?.itemsCoverage !== undefined && insights.db.accountsCoverage !== undefined) {
		list.push({ tone: 'info', text: `Processed so far: ${percentText(insights.db.itemsCoverage)} of the items and ${percentText(insights.db.accountsCoverage)} of the accounts.` });
	}
	return list;
};

/** A long time as a short text, for example "3h 20m" or "2d 4h". */
export const longDurationText = (ms: number): string => {
	const minutes = Math.round(ms / 60_000);
	if (minutes < 1) {
		return 'under a minute';
	}
	if (minutes < 60) {
		return `${minutes}m`;
	}
	const hours = Math.floor(minutes / 60);
	if (hours < 24) {
		return `${hours}h ${minutes % 60}m`;
	}
	return `${Math.floor(hours / 24)}d ${hours % 24}h`;
};
