import { CrawlerSetting } from './config';
import { MetricSeries, SERIES_BUCKETS } from './crawler-metrics';
import { SupervisorStatus } from './supervisor';
import { AttentionItem } from './ui-attention';
import { failuresPanel } from './ui-failures';
import {
	BAD_429_PER_HOUR,
	bytesText,
	detailAttrs,
	esc,
	formatNumber as number,
	hasProblem,
	HOURS_PER_MONTH,
	icon,
	isActive,
	isFailing,
	kpi,
	level429,
	rateText,
	shareBar,
	sparkline,
	stackedBars,
	stateDot,
	sumSeries,
	trendChart,
	WARN_429_PER_HOUR,
} from './ui-parts';

/** How many crawlers are in each state and of each type. */
export interface CrawlerSummary {
	total: number;
	running: number;
	/** Starting, running or stopping. */
	active: number;
	failed: number;
	/** Crawlers that need a look: failed, failing most URLs, a proxy warning or too many HTTP 429. */
	problems: number;
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
		problems: count(hasProblem),
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

/** Speeds are averages over the last five minutes, the 429 count is over the last hour. */
const AVG = 'avg 5 min';

const kpiRow = (status: SupervisorStatus, summary: CrawlerSummary): string => {
	const { db } = status;
	const series = hasSeries(status);
	const per429 = total(status, stats => stats.http429PerHour);
	// the level is the worst crawler, like the attention list: eight crawlers with a few answers each are not a problem
	const worst429 = status.crawlers.reduce<{ name: string; value: number } | undefined>((worst, crawler) => {
		const value = crawler.state === 'running' ? crawler.stats?.http429PerHour ?? 0 : 0;
		return value > (worst?.value ?? 0) ? { name: crawler.name, value } : worst;
	}, undefined);
	const over429 = status.crawlers.filter(crawler => crawler.state === 'running' && (crawler.stats?.http429PerHour ?? 0) >= BAD_429_PER_HOUR).length;
	const queue = db.dbStats?.queueLeft;
	const traffic = total(status, stats => stats.totals.bytes);
	const perHour = total(status, stats => stats.bytesPerHour);
	const links = total(status, stats => stats.totals.newLinks);
	const failingCount = status.crawlers.filter(isFailing).length;
	const failedPerMin = total(status, stats => stats.failedPerMin);
	const urlsPerMin = total(status, stats => stats.urlsPerMin);
	// share of the URLs done in the speed window that failed
	const failPercent = urlsPerMin > 0 ? Math.round((failedPerMin / urlsPerMin) * 100) : undefined;
	const crawlersSub = [
		summary.failed ? `<span class="lvl-bad">${summary.failed} failed</span>` : '',
		failingCount ? `<span class="lvl-bad">${failingCount} with errors</span>` : '',
		summary.paused ? `${summary.paused} paused` : '',
		summary.idle ? `${summary.idle} waiting` : '',
	].filter(Boolean).join(' · ') || 'running of all configured';
	const level = level429(worst429?.value ?? 0);
	const queueTotal = queue ? queue.items + queue.accounts : undefined;
	const successLevel = failPercent === undefined ? 'idle' : failPercent >= 30 ? 'bad' : failPercent >= 10 ? 'warn' : 'ok';
	return `<div class="kpis kpis-wide">
	${kpi('Crawlers', `${summary.active} / ${summary.total}`, crawlersSub, summary.failed || failingCount ? 'bad' : summary.active ? 'ok' : 'idle', '', '#crawlers',
		{ window: 'now', hint: 'Crawlers that are starting, running or stopping, of all crawlers in the config.' })}
	${kpi('URLs/min', rateText(urlsPerMin), `${esc(rateText(total(status, stats => stats.requestsPerMin)))} requests/min`, 'urls',
		series ? sparkline(allSeries(status, 'urls'), 'urls', 'URLs per minute, last 30 minutes') : '',
		'', { window: AVG, hint: 'URLs that were done (saved or failed) per minute. Requests are higher: retries and pauses use requests too.' })}
	${kpi('Success rate', failPercent === undefined ? '-' : `${100 - failPercent}%`, failPercent === undefined ? 'no URLs done yet' : `${failPercent}% of the URLs failed`, successLevel, '', '',
		{ window: AVG, hint: 'The share of done URLs that were saved. The rest failed.' })}
	${kpi('Errors/min', rateText(failedPerMin), failingCount ? `${failingCount} ${failingCount === 1 ? 'crawler fails' : 'crawlers fail'} most URLs` : failedPerMin ? 'failed URLs' : 'none', failingCount ? 'bad' : 'idle',
		series ? sparkline(allSeries(status, 'failed'), 'bad', 'Failed URLs per minute, last 30 minutes') : '',
		'', { window: AVG, hint: 'Failed URLs per minute, all crawlers.' })}
	${kpi('New links/min', rateText(total(status, stats => stats.linksPerMin)), `${esc(number(links))} links since the crawlers started`, 'links',
		series ? sparkline(allSeries(status, 'links'), 'links', 'New links per minute, last 30 minutes') : '',
		'', { window: AVG, hint: 'New links between an item and an account, as the crawlers report them. The DB counter on the Insights page can differ.' })}
	${kpi('Traffic/hour', bytesText(perHour), traffic ? `${esc(bytesText(traffic))} since start, ~${esc(bytesText(perHour * HOURS_PER_MONTH))}/month` : 'proxy traffic since start', 'traffic',
		series ? sparkline(allSeries(status, 'bytes'), 'traffic', 'Traffic per minute, last 30 minutes') : '', '#traffic',
		{ window: AVG, hint: 'Traffic through the proxies, counted as the proxy bills it. The month number is the speed times 30 days.' })}
	${kpi('HTTP 429/hour', number(per429), over429 ? `${over429} ${over429 === 1 ? 'crawler is' : 'crawlers are'} over ${BAD_429_PER_HOUR}/hour, slow down` : worst429 ? `most: ${esc(worst429.name)}, ${esc(number(worst429.value))}/hour` : 'none', level === 'ok' ? 'idle' : level,
		series ? sparkline(allSeries(status, 'http429'), 'r429', 'HTTP 429 per minute, last 30 minutes') : '',
		'', { window: 'last hour', hint: `All crawlers together. The color shows the worst crawler: ${WARN_429_PER_HOUR}/hour or more is a warning, ${BAD_429_PER_HOUR}/hour or more is a problem. The line shows 429 per minute.` })}
	${kpi('Queue left', queueTotal === undefined ? '-' : number(queueTotal), queue ? `${esc(number(queue.items))} items · ${esc(number(queue.accounts))} accounts` : 'unknown', 'queue', sparkline(db.queueHistory, 'queue', 'Queue left over time', true), '#insights',
		{ window: 'now', hint: 'URLs that wait to be taken, items and accounts together. The line is scaled to its own lowest and highest value.' })}
</div>`;
};

/** The metrics the main chart can show. The page script shows one, the choice stays in the browser. */
export const CHART_METRICS = [
	{ key: 'speed', label: 'Speed' },
	{ key: 'outcome', label: 'Outcome' },
	{ key: 'limits', label: 'HTTP 429' },
	{ key: 'links', label: 'New links' },
	{ key: 'traffic', label: 'Traffic' },
	{ key: 'errors', label: 'Errors' },
] as const;

/** Failed URLs per minute. A proxy that Bandcamp blocks shows here as a rise, while the other charts only fall. */
const errorsChart = (values: number[]): string =>
	trendChart([{ label: 'errors/min', tone: 'bad', values }], SERIES_BUCKETS, 'Failed URLs per minute');

const mainChart = (status: SupervisorStatus): string => {
	if (!hasSeries(status)) {
		return `<div class="panel panel-chart"><div class="panel-head"><h2>Activity</h2></div>
		<div class="empty">${icon('info')}<p>The chart shows up when a crawler sends its first report.</p></div></div>`;
	}
	const panes: Record<typeof CHART_METRICS[number]['key'], string> = {
		speed: trendChart([
			{ label: 'requests/min', tone: 'req', values: allSeries(status, 'requests') },
			{ label: 'URLs/min', tone: 'urls', values: allSeries(status, 'urls') },
		], SERIES_BUCKETS, 'Requests and URLs per minute'),
		// where the URLs went: saved or failed, so a falling success rate is visible at once
		outcome: stackedBars([
			{ label: 'saved/min', tone: 'urls', values: allSeries(status, 'urls').map((value, i) => Math.max(value - (allSeries(status, 'failed')[i] ?? 0), 0)) },
			{ label: 'failed/min', tone: 'bad', values: allSeries(status, 'failed') },
		], SERIES_BUCKETS, 'Saved and failed URLs per minute'),
		// 429 and errors are small next to requests, so they have their own scale
		limits: trendChart([{ label: 'HTTP 429/min', tone: 'r429', values: allSeries(status, 'http429') }], SERIES_BUCKETS, 'HTTP 429 answers per minute'),
		links: trendChart([{ label: 'new links/min', tone: 'links', values: allSeries(status, 'links') }], SERIES_BUCKETS, 'New item-account links per minute'),
		traffic: trendChart([{ label: 'traffic/min', tone: 'traffic', values: allSeries(status, 'bytes') }], SERIES_BUCKETS, 'Proxy traffic per minute', { format: bytesText }),
		errors: errorsChart(allSeries(status, 'failed')),
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

/** The line of a problem that many crawlers have: one line for all of them, it opens the table with the problems. */
const groupLine = (title: string, tone: AttentionItem['tone'], names: string[]): string => {
	const shown = names.slice(0, 4).join(', ') + (names.length > 4 ? ` and ${names.length - 4} more` : '');
	const body = `${icon('alert')}<span class="att-text"><b>${esc(title)} <span class="count count-${tone === 'bad' ? 'bad' : 'warn'}">${names.length} crawlers</span></b><span class="meta clip" title="${esc(names.join(', '))}">${esc(shown)}</span></span>`;
	return `<li class="att att-${tone}"><button type="button" class="att-open" data-goto-state="problems">${body}${icon('chevron', 'icon-next')}</button></li>`;
};

/** Lines about the same problem of several crawlers become one line, so ten crawlers do not fill the list. */
const groupedAttention = (items: AttentionItem[]): string[] => {
	const groups = new Map<string, AttentionItem[]>();
	for (const item of items) {
		const key = item.crawler ? `${item.tone}|${item.title.slice(item.crawler.length + 2)}` : `single|${groups.size}|${item.title}`;
		groups.set(key, [...(groups.get(key) ?? []), item]);
	}
	return [...groups.values()].map(list => list.length > 1 && list[0].crawler
		? groupLine(list[0].title.slice(list[0].crawler.length + 2), list[0].tone, list.map(item => item.crawler!))
		: attentionLine(list[0]));
};

const attentionPanel = (items: AttentionItem[]): string => {
	const problems = items.filter(item => item.tone !== 'info').length;
	const lines = groupedAttention(items);
	const shown = lines.slice(0, ATTENTION_LIMIT);
	const body = items.length === 0
		? `<div class="empty empty-ok">${icon('check')}<p>All clear. Nothing needs a look right now.</p></div>`
		: `<ul class="attention">${shown.join('')}</ul>`
			+ (lines.length > shown.length ? `<p class="meta">and ${lines.length - shown.length} more. <button type="button" class="link" data-goto-state="problems">Show the crawlers with problems</button></p>` : '');
	return `<div class="panel">
	<div class="panel-head"><h2>Needs attention ${problems ? `<span class="count count-bad">${problems}</span>` : ''}</h2></div>
	${body}
</div>`;
};

/** One line that answers "is it working?": the worst thing that needs a look, or that all is well. */
const verdictBar = (status: SupervisorStatus, attention: AttentionItem[], summary: CrawlerSummary): string => {
	const problems = attention.filter(item => item.tone !== 'info');
	const bad = problems.some(item => item.tone === 'bad');
	const idle = summary.total > 0 && summary.active === 0;
	const tone = bad ? 'bad' : problems.length || idle ? 'warn' : 'ok';
	const text = bad || problems.length
		? `${problems.length} ${problems.length === 1 ? 'problem needs' : 'problems need'} a look`
		: idle ? 'No crawler is running' : summary.total === 0 ? 'No crawlers yet' : 'Everything works';
	const sub = `${summary.active} of ${summary.total} crawlers running, DB service ${status.db.state}`;
	return `<div class="verdict verdict-${tone}" role="status">${icon(tone === 'ok' ? 'check' : 'alert')}<b>${esc(text)}</b><span class="meta">${esc(sub)}</span></div>`;
};

/** The share of each state as one bar, and links that open the crawler table with that filter. */
const statesPanel = (summary: CrawlerSummary): string => {
	const parts: Array<[string, string, number, string]> = [
		['active', 'Running', summary.active, 'running'],
		['failed', 'Failed', summary.failed, 'failed'],
		['stopped', 'Stopped', summary.stopped, 'stopped'],
	];
	const problemsRow = summary.problems
		? `<li><button type="button" class="state-row" data-goto-state="problems"><span class="dot dot-failed"></span>With problems<b>${summary.problems}</b></button></li>` : '';
	let x = 0;
	const segments = summary.total === 0 ? '' : parts.map(([, , count, tone]) => {
		const width = (count / summary.total) * 100;
		const rect = `<rect class="seg-${tone}" x="${x.toFixed(2)}" width="${width.toFixed(2)}" height="8"/>`;
		x += width;
		return rect;
	}).join('');
	const rows = parts.map(([state, label, count, tone]) => `
		<li><button type="button" class="state-row" data-goto-state="${state}"><span class="dot dot-${tone}"></span>${esc(label)}<b>${count}</b></button></li>`).join('') + problemsRow;
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
	${verdictBar(status, attention, summary)}
	${kpiRow(status, summary)}
	${mainChart(status)}
	<div class="cols">
		${attentionPanel(attention)}
		${statesPanel(summary)}
	</div>
	${failuresPanel(status)}
</div>`;

/** The traffic page: totals, the month estimate against the plan, a chart, and the share of each crawler. */
export const trafficView = (status: SupervisorStatus, settings: Map<string, CrawlerSetting>): string => {
	const local = status.crawlers.filter(crawler => settings.get(crawler.name)?.proxy.kind === 'none');
	const billed = status.crawlers.filter(crawler => settings.get(crawler.name)?.proxy.kind !== 'none');
	const sum = billed.reduce((all, crawler) => all + (crawler.stats?.totals.bytes ?? 0), 0);
	const perHour = billed.reduce((all, crawler) => all + (crawler.stats?.bytesPerHour ?? 0), 0);
	const month = perHour * HOURS_PER_MONTH;
	const saved = billed.reduce((all, crawler) => all + (crawler.stats?.totals.processed ?? 0), 0);
	const perThousand = saved > 0 ? (sum / saved) * 1000 : undefined;
	const rows = billed
		.filter(crawler => crawler.stats)
		.sort((a, b) => (b.stats?.totals.bytes ?? 0) - (a.stats?.totals.bytes ?? 0))
		.map(crawler => {
			const stats = crawler.stats!;
			const share = sum > 0 ? (stats.totals.bytes / sum) * 100 : 0;
			return `
		<li data-key="traffic:${esc(crawler.name)}">
			<button type="button" class="link traffic-name" ${detailAttrs(crawler.name)}>${stateDot(crawler.state)}<span class="clip">${esc(crawler.name)}</span>${isFailing(crawler) ? '<span class="pill pill-bad">errors</span>' : ''}</button>
			${shareBar(share, 'traffic', `${crawler.name}: ${Math.round(share)}% of the traffic`)}
			<span class="num"><b>${esc(bytesText(stats.totals.bytes))}</b><span class="sub">${Math.round(share)}% of all</span></span>
			<span class="num"><b>${esc(bytesText(stats.bytesPerHour))}/h</b></span>
			<span class="num"><b>~${esc(bytesText(stats.bytesPerHour * HOURS_PER_MONTH))}/mo</b></span>
		</li>`;
		}).join('');
	const chart = hasSeries(status)
		? trendChart([{ label: 'traffic/min', tone: 'traffic', values: sumSeries(billed.map(crawler => crawler.series?.bytes), SERIES_BUCKETS) }],
			SERIES_BUCKETS, 'Proxy traffic per minute', { format: bytesText })
		: `<div class="empty">${icon('info')}<p>The chart shows up when a crawler sends its first report.</p></div>`;
	const head = '<li class="traffic-head" aria-hidden="true"><span>Crawler</span><span>Share</span><span class="num">Since start</span><span class="num">Per hour</span><span class="num">Per month</span></li>';
	return `
<div class="view" data-view="traffic">
	<div class="kpis">
		${kpi('Since start', bytesText(sum), `${billed.length} crawlers with a proxy`, 'traffic', '', '', { window: 'since the crawlers started', hint: 'Not the billing month: the count starts again when a crawler starts.' })}
		${kpi('Per hour', bytesText(perHour), 'speed of the last minutes', 'traffic', '', '', { window: AVG })}
		${kpi('Month estimate', `~${bytesText(month)}`, 'this speed for 30 days', 'traffic', '', '', { window: AVG, hint: 'The speed of the last five minutes times 30 days. It moves a lot when the speed changes.' })}
		${kpi('Per 1,000 pages', perThousand === undefined ? '-' : bytesText(perThousand), 'traffic for 1,000 saved pages', 'traffic', '', '', { window: 'since start', hint: 'Traffic divided by the saved pages. A rise means more traffic is wasted on errors and retries.' })}
		<div class="kpi kpi-plan" data-plan data-month-bytes="${month}">
			<label class="kpi-label" for="plan-gb">Plan, GB per month</label>
			<input id="plan-gb" type="number" min="0" step="any" inputmode="decimal" placeholder="not set" data-plan-input>
			<span class="kpi-sub" data-plan-text>Enter the plan to compare</span>
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
		? `<ul class="traffic-rows">${head}${rows}</ul>`
		: `<div class="empty">${icon('traffic')}<p>No traffic yet. It is counted for crawlers that use a proxy, after their first report.</p></div>`}
		${local.length ? `<p class="meta">Not counted, they use the local IP: ${esc(local.map(crawler => crawler.name).join(', '))}</p>` : ''}
	</div>
</div>`;
};
