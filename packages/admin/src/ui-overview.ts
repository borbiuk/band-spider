import { CrawlerSetting } from './config';
import { MetricSeries, SERIES_BUCKETS } from './crawler-metrics';
import { SupervisorStatus } from './supervisor';
import { AttentionItem } from './ui-attention';
import {
	BAD_429_PER_HOUR,
	bytesText,
	detailAttrs,
	esc,
	formatNumber as number,
	HOURS_PER_MONTH,
	icon,
	isActive,
	kpi,
	level429,
	rateText,
	shareBar,
	sparkline,
	stateDot,
	sumSeries,
	trendChart,
} from './ui-parts';

/** How many crawlers are in each state and of each type. */
export interface CrawlerSummary {
	total: number;
	running: number;
	/** Starting, running or stopping. */
	active: number;
	failed: number;
	stopped: number;
	paused: number;
	idle: number;
	items: number;
	accounts: number;
}

export const summarize = (status: SupervisorStatus, settings: Map<string, CrawlerSetting>): CrawlerSummary => {
	const { crawlers } = status;
	const count = (test: (crawler: SupervisorStatus['crawlers'][number]) => boolean): number => crawlers.filter(test).length;
	return {
		total: crawlers.length,
		running: count(crawler => crawler.state === 'running'),
		active: count(crawler => isActive(crawler.state)),
		failed: count(crawler => crawler.state === 'failed'),
		stopped: count(crawler => crawler.state === 'stopped'),
		paused: count(crawler => crawler.state === 'running' && (crawler.stats?.pauseMs ?? 0) > 0),
		idle: count(crawler => crawler.state === 'running' && crawler.stats?.idle === true),
		items: count(crawler => settings.get(crawler.name)?.type === 'item'),
		accounts: count(crawler => settings.get(crawler.name)?.type === 'account'),
	};
};

/** The sum of one value over all crawlers. */
const total = (status: SupervisorStatus, pick: (stats: NonNullable<SupervisorStatus['crawlers'][number]['stats']>) => number): number =>
	status.crawlers.reduce((sum, crawler) => sum + (crawler.stats ? pick(crawler.stats) : 0), 0);

/** The series of all crawlers added together. */
const allSeries = (status: SupervisorStatus, field: keyof MetricSeries): number[] =>
	sumSeries(status.crawlers.map(crawler => crawler.series?.[field]), SERIES_BUCKETS);

const hasSeries = (status: SupervisorStatus): boolean => status.crawlers.some(crawler => crawler.series);

const kpiRow = (status: SupervisorStatus, summary: CrawlerSummary): string => {
	const { db } = status;
	const series = hasSeries(status);
	const per429 = total(status, stats => stats.http429PerHour);
	const queue = db.dbStats?.queueLeft;
	const traffic = total(status, stats => stats.totals.bytes);
	const perHour = total(status, stats => stats.bytesPerHour);
	const links = total(status, stats => stats.totals.newLinks);
	const crawlersSub = [
		summary.failed ? `<span class="lvl-bad">${summary.failed} failed</span>` : '',
		summary.paused ? `${summary.paused} paused` : '',
		summary.idle ? `${summary.idle} waiting` : '',
	].filter(Boolean).join(' · ') || 'running / total';
	const level = level429(per429);
	return `<div class="kpis">
	${kpi('Crawlers', `${summary.running} / ${summary.total}`, crawlersSub, summary.failed ? 'bad' : summary.running ? 'ok' : 'idle', '', '#crawlers')}
	${kpi('URLs/min', rateText(total(status, stats => stats.urlsPerMin)), `${esc(rateText(total(status, stats => stats.requestsPerMin)))} requests/min`, 'urls',
		series ? sparkline(allSeries(status, 'urls'), 'urls', 'URLs per minute, last 30 minutes') : '')}
	${kpi('New links/min', rateText(total(status, stats => stats.linksPerMin)), `${esc(number(links))} item-account links since start`, 'links',
		series ? sparkline(allSeries(status, 'links'), 'links', 'New links per minute, last 30 minutes') : '')}
	${kpi('Traffic/hour', bytesText(perHour), traffic ? `${esc(bytesText(traffic))} since start, ~${esc(bytesText(perHour * HOURS_PER_MONTH))}/month` : 'proxy traffic since start', 'traffic',
		series ? sparkline(allSeries(status, 'bytes'), 'traffic', 'Traffic per minute, last 30 minutes') : '', '#traffic')}
	${kpi('HTTP 429/hour', number(per429), per429 >= BAD_429_PER_HOUR ? 'too many, slow down' : per429 ? 'rate limited' : 'none', level === 'ok' ? 'idle' : level,
		series ? sparkline(allSeries(status, 'http429'), 'r429', 'HTTP 429 per minute, last 30 minutes') : '')}
	${kpi('Queue left', queue ? number(queue.items) : '-', queue ? `items, ${esc(number(queue.accounts))} accounts` : 'unknown', 'queue', sparkline(db.queueHistory, 'queue', 'Queue left over time'), '#insights')}
</div>`;
};

/** The metrics the main chart can show. The page script shows one, the choice stays in the browser. */
export const CHART_METRICS = [
	{ key: 'speed', label: 'Speed' },
	{ key: 'links', label: 'New links' },
	{ key: 'traffic', label: 'Traffic' },
] as const;

const mainChart = (status: SupervisorStatus): string => {
	if (!hasSeries(status)) {
		return `<div class="panel panel-chart"><div class="panel-head"><h2>Activity</h2></div>
		<div class="empty">${icon('info')}<p>The chart shows up when a crawler sends its first report.</p></div></div>`;
	}
	const panes: Record<typeof CHART_METRICS[number]['key'], string> = {
		speed: trendChart([
			{ label: 'requests/min', tone: 'req', values: allSeries(status, 'requests') },
			{ label: 'URLs/min', tone: 'urls', values: allSeries(status, 'urls') },
			{ label: 'HTTP 429/min', tone: 'r429', values: allSeries(status, 'http429') },
		], SERIES_BUCKETS),
		links: trendChart([{ label: 'new links/min', tone: 'links', values: allSeries(status, 'links') }], SERIES_BUCKETS, 'New item-account links per minute'),
		traffic: trendChart([{ label: 'traffic/min', tone: 'traffic', values: allSeries(status, 'bytes') }], SERIES_BUCKETS, 'Proxy traffic per minute', { format: bytesText }),
	};
	const picks = CHART_METRICS.map(metric =>
		`<button type="button" data-chart-pick="${metric.key}" aria-pressed="false">${esc(metric.label)}</button>`).join('');
	return `<div class="panel panel-chart">
	<div class="panel-head"><h2>Activity, last ${SERIES_BUCKETS} min</h2><div class="seg" role="group" aria-label="Chart">${picks}</div></div>
	${CHART_METRICS.map(metric => `<div class="chart-pane" data-chart-pane="${metric.key}">${panes[metric.key]}</div>`).join('')}
</div>`;
};

const attentionLine = (item: AttentionItem): string => {
	const sign = item.tone === 'info' ? icon('info') : icon('alert');
	const body = `${sign}<span class="att-text"><b>${esc(item.title)}</b><span class="meta clip" title="${esc(item.detail)}">${esc(item.detail)}</span></span>`;
	return item.crawler
		? `<li class="att att-${item.tone}"><button type="button" class="att-open" ${detailAttrs(item.crawler)}>${body}${icon('chevron', 'icon-next')}</button></li>`
		: `<li class="att att-${item.tone}"><div class="att-open">${body}</div></li>`;
};

/** How many lines the overview shows before it says "and N more". */
const ATTENTION_LIMIT = 8;

const attentionPanel = (items: AttentionItem[]): string => {
	const problems = items.filter(item => item.tone !== 'info').length;
	const shown = items.slice(0, ATTENTION_LIMIT);
	const body = items.length === 0
		? `<div class="empty empty-ok">${icon('check')}<p>All clear. Nothing needs a look right now.</p></div>`
		: `<ul class="attention">${shown.map(attentionLine).join('')}</ul>`
			+ (items.length > shown.length ? `<p class="meta">and ${items.length - shown.length} more. <a href="#crawlers">Open the crawlers</a></p>` : '');
	return `<div class="panel">
	<div class="panel-head"><h2>Needs attention ${problems ? `<span class="count count-bad">${problems}</span>` : ''}</h2></div>
	${body}
</div>`;
};

/** The share of each state as one bar, and links that open the crawler table with that filter. */
const statesPanel = (summary: CrawlerSummary): string => {
	const parts: Array<[string, string, number, string]> = [
		['active', 'Running', summary.active, 'running'],
		['failed', 'Failed', summary.failed, 'failed'],
		['stopped', 'Stopped', summary.stopped, 'stopped'],
	];
	let x = 0;
	const segments = summary.total === 0 ? '' : parts.map(([, , count, tone]) => {
		const width = (count / summary.total) * 100;
		const rect = `<rect class="seg-${tone}" x="${x.toFixed(2)}" width="${width.toFixed(2)}" height="8"/>`;
		x += width;
		return rect;
	}).join('');
	const rows = parts.map(([state, label, count, tone]) => `
		<li><button type="button" class="state-row" data-goto-state="${state}"><span class="dot dot-${tone}"></span>${esc(label)}<b>${count}</b></button></li>`).join('');
	const notes = summary.active ? `<p class="meta">Of the running: ${summary.paused} in a pause, ${summary.idle} with no URLs to do.</p>` : '';
	return `<div class="panel">
	<div class="panel-head"><h2>Crawlers</h2><a class="meta" href="#crawlers">Open table ${icon('chevron', 'icon-next')}</a></div>
	${summary.total === 0
		? `<div class="empty">${icon('crawlers')}<p>No crawlers yet. Add one, or create them from the proxy pool.</p><a class="btn-ghost" href="#proxies">Open proxies</a></div>`
		: `<svg class="bar bar-states" viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label="Crawler states">${segments}</svg>
	<ul class="state-rows">${rows}</ul>
	${notes}
	<div class="type-split meta"><button type="button" class="link" data-goto-type="item">${summary.items} item crawlers</button> · <button type="button" class="link" data-goto-type="account">${summary.accounts} account crawlers</button></div>`}
</div>`;
};

/** The overview page: the KPIs, one chart with a switch, what needs attention and the crawler states. */
export const overviewView = (status: SupervisorStatus, attention: AttentionItem[], summary: CrawlerSummary): string => `
<div class="view" data-view="overview">
	${kpiRow(status, summary)}
	${mainChart(status)}
	<div class="cols">
		${attentionPanel(attention)}
		${statesPanel(summary)}
	</div>
</div>`;

/** The traffic page: totals, the month estimate against the plan, a chart, and the share of each crawler. */
export const trafficView = (status: SupervisorStatus, settings: Map<string, CrawlerSetting>): string => {
	const local = status.crawlers.filter(crawler => settings.get(crawler.name)?.proxy.kind === 'none');
	const billed = status.crawlers.filter(crawler => settings.get(crawler.name)?.proxy.kind !== 'none');
	const sum = billed.reduce((all, crawler) => all + (crawler.stats?.totals.bytes ?? 0), 0);
	const perHour = billed.reduce((all, crawler) => all + (crawler.stats?.bytesPerHour ?? 0), 0);
	const month = perHour * HOURS_PER_MONTH;
	const rows = billed
		.filter(crawler => crawler.stats)
		.sort((a, b) => (b.stats?.totals.bytes ?? 0) - (a.stats?.totals.bytes ?? 0))
		.map(crawler => {
			const stats = crawler.stats!;
			const share = sum > 0 ? (stats.totals.bytes / sum) * 100 : 0;
			return `
		<li data-key="traffic:${esc(crawler.name)}">
			<button type="button" class="link traffic-name" ${detailAttrs(crawler.name)}>${stateDot(crawler.state)}<span class="clip">${esc(crawler.name)}</span></button>
			${shareBar(share, 'traffic', `${crawler.name}: ${Math.round(share)}% of the traffic`)}
			<span class="num"><b>${esc(bytesText(stats.totals.bytes))}</b><span class="sub">${Math.round(share)}%</span></span>
			<span class="num"><b>${esc(bytesText(stats.bytesPerHour))}</b><span class="sub">per hour</span></span>
			<span class="num"><b>~${esc(bytesText(stats.bytesPerHour * HOURS_PER_MONTH))}</b><span class="sub">per month</span></span>
		</li>`;
		}).join('');
	const chart = hasSeries(status)
		? trendChart([{ label: 'traffic/min', tone: 'traffic', values: sumSeries(billed.map(crawler => crawler.series?.bytes), SERIES_BUCKETS) }],
			SERIES_BUCKETS, 'Proxy traffic per minute', { format: bytesText })
		: `<div class="empty">${icon('info')}<p>The chart shows up when a crawler sends its first report.</p></div>`;
	return `
<div class="view" data-view="traffic">
	<div class="kpis">
		${kpi('Since start', bytesText(sum), `${billed.length} crawlers with a proxy`, 'traffic')}
		${kpi('Per hour', bytesText(perHour), 'from the speed of the last minutes', 'traffic')}
		${kpi('Month estimate', `~${bytesText(month)}`, 'at this speed, 30 days', 'traffic')}
		<div class="kpi kpi-plan" data-plan data-month-bytes="${month}">
			<label class="kpi-label" for="plan-gb">Plan, GB per month</label>
			<input id="plan-gb" type="number" min="0" step="any" inputmode="decimal" placeholder="not set" data-plan-input>
			<span class="kpi-sub clip" data-plan-text>Enter the plan to compare</span>
			<svg class="bar bar-plan" viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true"><rect class="bar-bg" width="100" height="8"/><rect class="bar-fill" data-plan-bar width="0" height="8"/></svg>
		</div>
	</div>
	<div class="panel panel-chart">
		<div class="panel-head"><h2>Traffic per minute, last ${SERIES_BUCKETS} min</h2></div>
		${chart}
	</div>
	<div class="panel">
		<div class="panel-head"><h2>By crawler</h2><span class="meta">sent and received, still compressed, as the proxy bills it</span></div>
		${rows
		? `<ul class="traffic-rows">${rows}</ul>`
		: `<div class="empty">${icon('traffic')}<p>No traffic yet. It is counted for crawlers that use a proxy, after their first report.</p></div>`}
		${local.length ? `<p class="meta">Not counted, they use the local IP: ${esc(local.map(crawler => crawler.name).join(', '))}</p>` : ''}
	</div>
</div>`;
};
