import {
	computeInsights,
	flowSeries,
	FLOW_BUCKETS,
	Insights,
	longDurationText,
	NoveltyRow,
	Takeaway,
} from './insights';
import { InsightsSnapshot } from './supervisor';
import { button, esc, formatNumber as number, kpi, trendChart } from './ui-render';

const perMinuteText = (value?: number): string => value === undefined ? 'speed unknown yet' : `${number(Math.round(value * 10) / 10)} / min`;

const percent = (value?: number): string => value === undefined ? '-' : `${value}%`;

const decimal = (value?: number): string => value === undefined ? '-' : number(value);

const BAR_WIDTH = 100;
const BAR_HEIGHT = 8;

/** A bar as inline SVG. It uses attributes and classes only, because the page CSP has no inline styles. */
const bar = (value: number | undefined, tone: string, label: string): string => {
	const width = Math.min(Math.max(value ?? 0, 0), 100);
	return `<svg class="bar bar-${tone}" viewBox="0 0 ${BAR_WIDTH} ${BAR_HEIGHT}" preserveAspectRatio="none" role="img" aria-label="${esc(label)}">`
		+ `<rect class="bar-bg" width="${BAR_WIDTH}" height="${BAR_HEIGHT}"/>`
		+ `<rect class="bar-fill" width="${width}" height="${BAR_HEIGHT}"/></svg>`;
};

/** A bar of collection and wishlist: the blue part is the collection share, the rest is the wishlist. */
const splitBar = (collectionShare: number | undefined, label: string): string => {
	if (collectionShare === undefined) {
		return bar(undefined, 'a', `${label}: no data`);
	}
	const collection = Math.min(Math.max(collectionShare, 0), 100);
	return `<svg class="bar bar-split" viewBox="0 0 ${BAR_WIDTH} ${BAR_HEIGHT}" preserveAspectRatio="none" role="img" aria-label="${esc(label)}">`
		+ `<rect class="bar-wish" width="${BAR_WIDTH}" height="${BAR_HEIGHT}"/>`
		+ `<rect class="bar-coll" width="${collection}" height="${BAR_HEIGHT}"/></svg>`;
};

const noveltyTone = (value?: number): string => value === undefined ? 'a' : value < 5 ? 'low' : value >= 30 ? 'high' : 'mid';

const noveltyList = (rows: NoveltyRow[]): string => `
<ul class="rows">${rows.map(row => `
	<li>
		<span class="row-label">${esc(row.label)}</span>
		${bar(row.percent, noveltyTone(row.percent), `${row.label}: ${percent(row.percent)} new`)}
		<span class="row-value"><b>${percent(row.percent)}</b> <span class="meta">${number(row.fresh)} of ${number(row.total)}</span></span>
	</li>`).join('')}
</ul>`;

const line = (label: string, value: string): string =>
	`<li class="line-row"><span class="meta">${esc(label)}</span><b>${esc(value)}</b></li>`;

const takeawayList = (list: Takeaway[]): string => list.length === 0 ? '' : `
<ul class="takeaways">${list.map(item => `<li class="takeaway takeaway-${item.tone}">${esc(item.text)}</li>`).join('')}</ul>`;

const splitBlock = (insights: Insights): string => {
	const { db, added } = insights;
	const newTotal = added.collectionLinks + added.wishlistLinks;
	const inDb = db
		? `<div class="split-row"><span class="meta">In the DB</span>${splitBar(db.wishlistShare === undefined ? undefined : 100 - db.wishlistShare, 'Collection and wishlist links in the DB')}
			<span class="meta">collection <b>${number(db.collectionLinks)}</b> · wishlist <b>${number(db.totals.wishlistRelations)}</b> (${percent(db.wishlistShare)})</span></div>`
		: '<p class="meta">The DB size is not known yet.</p>';
	const fresh = `<div class="split-row"><span class="meta">New since start</span>${splitBar(insights.wishlistShareNew === undefined ? undefined : 100 - insights.wishlistShareNew, 'New collection and wishlist links')}
		<span class="meta">collection <b>${number(added.collectionLinks)}</b> · wishlist <b>${number(added.wishlistLinks)}</b> (${newTotal > 0 ? percent(insights.wishlistShareNew) : '-'})</span></div>`;
	return `<div class="split-legend"><span class="legend"><i class="swatch bar-coll-dot"></i>collection</span><span class="legend"><i class="swatch bar-wish-dot"></i>wishlist</span></div>${inDb}${fresh}`;
};

const queueBlock = (insights: Insights): string => {
	const { queue, db } = insights;
	const eta = queue.etaMs !== undefined ? longDurationText(queue.etaMs) : queue.growing ? 'never, the queue grows' : '-';
	const rows = [
		line('Queue left (items + accounts)', queue.left === undefined ? 'unknown' : number(queue.left)),
		line('New URLs found since start', number(queue.discovered)),
		line('Pages saved since start', number(queue.consumed)),
		line('Net change of the queue', `${queue.net > 0 ? '+' : ''}${number(queue.net)}`),
		line('Time to an empty queue', eta),
	];
	const coverage = db ? `
		<li class="split-row"><span class="meta">Items processed</span>${bar(db.itemsCoverage, 'high', `Items processed: ${percent(db.itemsCoverage)}`)}<b>${percent(db.itemsCoverage)}</b></li>
		<li class="split-row"><span class="meta">Accounts processed</span>${bar(db.accountsCoverage, 'high', `Accounts processed: ${percent(db.accountsCoverage)}`)}<b>${percent(db.accountsCoverage)}</b></li>` : '';
	return `<ul class="rows plain">${rows.join('')}${coverage}</ul>`;
};

const sizeBlock = (insights: Insights, snapshot: InsightsSnapshot): string => {
	const { db } = insights;
	if (!db) {
		return snapshot.totalsError
			? `<p class="error">DB size: ${esc(snapshot.totalsError)}</p>`
			: '<p class="meta">Counting the rows of the DB. A big DB needs some time, this view updates when it is done.</p>';
	}
	return `<ul class="rows plain">
		${line('Items', number(db.totals.items))}
		${line('Accounts', number(db.totals.accounts))}
		${line('Links item - account', number(db.totals.itemAccountRelations))}
		${line('Follows', number(db.totals.followers))}
		${line('Links per account', decimal(db.linksPerAccount))}
		${line('Links per item', decimal(db.linksPerItem))}
	</ul>
	<p class="meta">Counted ${esc(db.totals.countedAt.toISOString().slice(0, 19).replace('T', ' '))} UTC, and again every few minutes while this view is open.</p>`;
};

const crawlerTable = (insights: Insights): string => insights.crawlers.length === 0
	? '<p class="meta">No crawler has reported yet.</p>'
	: `<table class="efficiency">
	<thead><tr><th>Crawler</th><th>Requests</th><th>Saved</th><th>Saved per request</th><th>Failed</th><th>HTTP 429/hour</th></tr></thead>
	<tbody>${insights.crawlers.map(row => `
		<tr><td><b>${esc(row.name)}</b></td><td>${number(row.requests)}</td><td>${number(row.saved)}</td><td>${decimal(row.savedPerRequest)}</td>
		<td>${number(row.failed)} <span class="meta">${percent(row.failedPercent)}</span></td><td>${number(row.http429PerHour)}</td></tr>`).join('')}
	</tbody></table>`;

/** The Insights view: how well the crawl fills the DB. It floats over the page, like the form. */
export const renderInsights = (snapshot: InsightsSnapshot, now: number): string => {
	const stats = snapshot.db.dbStats;
	const head = `
	<div class="drawer-head">
		<h2>Database insights</h2>
		${button('Close', 'data-close hx-get="/fragments/insights-close" hx-target="#insights" hx-swap="innerHTML"')}
	</div>`;
	if (!stats) {
		return `<div class="modal"><div class="panel modal-card modal-wide insights" role="dialog" aria-modal="true" aria-label="Database insights">${head}
		<p class="meta">The DB service is not running, so there is nothing to show. Start it and the numbers appear here.</p></div></div>`;
	}

	const insights = computeInsights({ stats, totals: snapshot.totals, history: snapshot.history, crawlers: snapshot.crawlers, now });
	const series = (field: 'items' | 'accounts' | 'links') => flowSeries(snapshot.history, field, now);
	const growth = snapshot.history.length >= 2
		? trendChart([
			{ label: 'new items/min', tone: 'items', values: series('items') },
			{ label: 'new accounts/min', tone: 'accounts', values: series('accounts') },
			{ label: 'new links/min', tone: 'links', values: series('links') },
		], FLOW_BUCKETS, 'New records per minute')
		: '<p class="meta">The chart shows up after a few readings of the DB service.</p>';
	const since = insights.sinceMs === undefined ? '' : `, ${longDurationText(insights.sinceMs)} ago`;
	const pageSplit = `${number(insights.pages.items)} item pages, ${number(insights.pages.accounts)} account pages`;

	return `<div class="modal"><div class="panel modal-card modal-wide insights" role="dialog" aria-modal="true" aria-label="Database insights">
	${head}
	<p class="meta">Counters of the DB service since it started${esc(since)}. They start from zero when it restarts.</p>
	<div class="kpis">
		${kpi('New items', number(insights.added.items), esc(perMinuteText(insights.perMinute.items)), 'req')}
		${kpi('New accounts', number(insights.added.accounts), esc(perMinuteText(insights.perMinute.accounts)), 'urls')}
		${kpi('New item-account links', number(insights.added.links), esc(perMinuteText(insights.perMinute.links)), 'queue')}
		${kpi('Pages saved', number(insights.pages.total), esc(pageSplit), 'idle')}
		${kpi('New records per page', decimal(insights.yield.newRecordsPerPage), `${decimal(insights.yield.linksPerPage)} links per page`, 'idle')}
	</div>
	${takeawayList(insights.takeaways)}
	<div class="panel panel-inner">
		<h3>Growth of the DB per minute</h3>
		${growth}
	</div>
	<div class="insights-grid">
		<div class="panel panel-inner">
			<h3>How much of what the pages show is new</h3>
			<p class="meta">A low share means the DB already has most of it. Records are items, accounts and tags on the saved pages.</p>
			${noveltyList(insights.novelty)}
		</div>
		<div class="panel panel-inner">
			<h3>Collection and wishlist</h3>
			<p class="meta">Links between an item and an account.</p>
			${splitBlock(insights)}
		</div>
		<div class="panel panel-inner">
			<h3>Queue and coverage</h3>
			${queueBlock(insights)}
		</div>
		<div class="panel panel-inner">
			<h3>Size of the DB</h3>
			${sizeBlock(insights, snapshot)}
		</div>
	</div>
	<div class="panel panel-inner">
		<h3>Crawler efficiency</h3>
		${crawlerTable(insights)}
	</div>
</div></div>`;
};
