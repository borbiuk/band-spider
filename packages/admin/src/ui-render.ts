import { DEFAULT_IDLE_MS, MAX_REQUEST_DELAY_MS, MIN_REQUEST_DELAY_MS } from '@band-spider/core';
import { AdminConfig, CrawlerSetting, DEFAULT_REVERSE, DEFAULT_WORKERS } from './config';
import { CrawlerStats, SERIES_BUCKETS } from './crawler-metrics';
import { CrawlerCounts } from './managed-child';
import { ImportResult, PoolItem } from './proxy-pool';
import { CrawlerStatus, DbStatus, SupervisorStatus } from './supervisor';

/** Escapes text for HTML, so a log line or a name cannot add markup. */
export const esc = (value: unknown): string =>
	String(value ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');

// Child output has ANSI colors, the page shows plain text
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
export const stripAnsi = (text: string): string => text.replace(ANSI, '');

const stateBadge = (state: string): string => `<span class="state state-${esc(state)}">${esc(state)}</span>`;

const countsText = (counts?: CrawlerCounts): string =>
	counts ? `${counts.claimed} claimed, ${counts.saved} saved, ${counts.failed} failed, ${counts.rateLimited} rate limited` : '-';

const number = (value: number): string => value.toLocaleString('en-US');
export const formatNumber = number;

/** A pause in ms as a short text, for example "1m 05s". */
export const durationText = (ms: number): string => {
	const seconds = Math.ceil(ms / 1000);
	return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s` : `${seconds}s`;
};

/** HTTP 429 answers per hour: a few are normal, about one a minute is a problem. */
const WARN_429_PER_HOUR = 1;
const BAD_429_PER_HOUR = 60;

const level429 = (perHour: number): string =>
	perHour >= BAD_429_PER_HOUR ? 'bad' : perHour >= WARN_429_PER_HOUR ? 'warn' : 'ok';

const stat = (value: string, label: string, level = ''): string =>
	`<span class="stat${level ? ` stat-${level}` : ''}"><b>${esc(value)}</b> ${esc(label)}</span>`;

/**
 * The speeds and totals of a crawler. The block always has the same lines, so a row keeps its height
 * when a crawler pauses, waits or has not reported yet.
 */
export const statsText = (stats?: CrawlerStats): string => {
	if (!stats) {
		return `<div class="stats">${stat('-', 'requests/min')}${stat('-', 'URLs/min')}${stat('-', 'HTTP 429/hour')}</div>`
			+ '<div class="meta clip">&nbsp;</div>'
			+ '<div class="note meta">no report yet</div>';
	}
	const total = `total: ${number(stats.totals.requests)} requests, ${number(stats.totals.processed)} saved, `
		+ `${number(stats.totals.failed)} failed, ${number(stats.totals.http429)} HTTP 429`;
	const paused = stats.pauseMs > 0 ? `paused after HTTP 429, ${esc(durationText(stats.pauseMs))} left` : '';
	const notes = [paused, stats.idle ? 'waiting for URLs' : ''].filter(Boolean).join(', ');
	const note = `<div class="note ${paused ? 'warn' : 'meta'}">${notes || '&nbsp;'}</div>`;
	return `<div class="stats">${stat(number(stats.requestsPerMin), 'requests/min')}${stat(number(stats.urlsPerMin), 'URLs/min')}`
		+ `${stat(number(stats.http429PerHour), 'HTTP 429/hour', level429(stats.http429PerHour))}</div>`
		+ `<div class="meta clip" title="${esc(total)}">${esc(total)}</div>${note}`;
};

/** A short text for the proxy column. It never has a user name or a password. */
export const proxyText = (setting: CrawlerSetting): string => {
	const { proxy } = setting;
	switch (proxy.kind) {
		case 'none':
			return 'local IP';
		case 'url':
			try {
				return `proxy ${new URL(proxy.url).host}`;
			} catch {
				return 'proxy';
			}
		case 'webshare':
			return `webshare ${proxy.entry.host}:${proxy.entry.port}`;
		case 'webshare-list':
			return proxy.id !== undefined ? `webshare list, id ${proxy.id}` : `webshare list, #${proxy.index}`;
		case 'pool':
			return `pool ${proxy.key}`;
	}
};

/** The settings of a crawler that differ from the defaults. Type and proxy are always there. */
export const settingsText = (setting: CrawlerSetting): string => {
	const parts: string[] = [setting.type];
	if (setting.reverse !== DEFAULT_REVERSE) {
		parts.push('reverse');
	}
	if (setting.workers !== DEFAULT_WORKERS) {
		parts.push(`${setting.workers} workers`);
	}
	const { minDelayMs, maxDelayMs } = setting;
	if (minDelayMs !== undefined && maxDelayMs !== undefined) {
		parts.push(`delay ${minDelayMs}-${maxDelayMs} ms`);
	} else if (minDelayMs !== undefined) {
		parts.push(`min delay ${minDelayMs} ms`);
	} else if (maxDelayMs !== undefined) {
		parts.push(`max delay ${maxDelayMs} ms`);
	}
	if (setting.idleMs !== undefined) {
		parts.push(setting.idleMs === 0 ? 'exits when no URLs' : `waits ${setting.idleMs} ms when no URLs`);
	}
	return parts.join(', ');
};

/**
 * A message that shows in the corner of the page and does not depend on the status block, so the next
 * live update cannot remove it. Errors stay until they are closed, the others go away alone.
 */
export const toast = (kind: 'error' | 'warn' | 'ok', message: string): string =>
	`<div id="toasts" hx-swap-oob="beforeend"><div class="toast toast-${kind}" role="${kind === 'error' ? 'alert' : 'status'}"`
	+ `${kind === 'error' ? '' : ' data-ttl="5000"'}><span>${esc(message)}</span>`
	+ '<button type="button" class="toast-close" aria-label="Dismiss">&times;</button></div></div>';

export type Tone = 'primary' | 'ok' | 'warn' | 'danger' | 'ghost';

export const button = (label: string, attrs: string, disabled = false, tone: Tone = 'ghost'): string =>
	`<button type="button" class="btn-${tone}" ${attrs}${disabled ? ' disabled' : ''}>${esc(label)}</button>`;

/** A button that posts to the server and shows the new status. The status is changed in place, so the page does not jump. */
const action = (path: string, label: string, disabled = false, confirm?: string, tone: Tone = 'ghost'): string =>
	button(label, `hx-post="${esc(path)}" hx-target="#status" hx-swap="morph"${confirm ? ` hx-confirm="${esc(confirm)}"` : ''}`, disabled, tone);

const isActive = (state: string): boolean => state === 'starting' || state === 'running' || state === 'stopping';

const SPARK_W = 100;
const SPARK_H = 30;

const sparkPoints = (values: number[], max: number, height: number, width: number): string =>
	values.map((value, i) => {
		const x = values.length > 1 ? (i / (values.length - 1)) * width : 0;
		const y = height - 1 - (Math.max(value, 0) / max) * (height - 2);
		return `${x.toFixed(1)},${y.toFixed(1)}`;
	}).join(' ');

/**
 * A tiny line chart as inline SVG. It uses attributes and classes only, because the page CSP has no inline styles.
 * Without values it draws a flat line of the same size, so the cell does not change its height.
 */
export const sparkline = (values: number[] | undefined, tone: string, label: string): string => {
	if (!values || values.length < 2) {
		return `<svg class="spark spark-${tone} spark-empty" viewBox="0 0 ${SPARK_W} ${SPARK_H}" preserveAspectRatio="none" role="img" aria-label="${esc(label)}: no data">`
			+ `<polyline class="line" fill="none" points="0,${SPARK_H - 1} ${SPARK_W},${SPARK_H - 1}"/></svg>`;
	}
	const max = Math.max(...values, 1);
	const points = sparkPoints(values, max, SPARK_H, SPARK_W);
	return `<svg class="spark spark-${tone}" viewBox="0 0 ${SPARK_W} ${SPARK_H}" preserveAspectRatio="none" role="img" aria-label="${esc(label)}">`
		+ `<title>${esc(label)}</title>`
		+ `<polygon class="area" points="0,${SPARK_H} ${points} ${SPARK_W},${SPARK_H}"/>`
		+ `<polyline class="line" fill="none" points="${points}"/></svg>`;
};

export interface ChartLine {
	label: string;
	tone: string;
	values: number[];
}

const CHART_W = 600;
const CHART_H = 120;

/** The chart of all crawlers together: one line for each value, a shared scale, three grid lines. */
export const trendChart = (lines: ChartLine[], minutes: number, title = 'Requests and URLs per minute'): string => {
	const max = Math.max(...lines.flatMap(line => line.values), 1);
	const grid = [0.25, 0.5, 0.75].map(part => {
		const y = (CHART_H * part).toFixed(1);
		return `<line class="grid" x1="0" y1="${y}" x2="${CHART_W}" y2="${y}"/>`;
	}).join('');
	const drawn = lines.map(line => {
		const points = sparkPoints(line.values, max, CHART_H, CHART_W);
		return `<polygon class="area chart-${line.tone}" points="0,${CHART_H} ${points} ${CHART_W},${CHART_H}"/>`
			+ `<polyline class="line chart-${line.tone}" fill="none" points="${points}"/>`;
	}).join('');
	const legend = lines.map(line =>
		`<span class="legend"><i class="swatch chart-${line.tone}"></i>${esc(line.label)}, now <b>${number(line.values[line.values.length - 1] ?? 0)}</b></span>`).join('');
	return `<div class="chart-legend">${legend}<span class="meta">peak ${number(max)} per minute</span></div>
	<svg class="chart" viewBox="0 0 ${CHART_W} ${CHART_H}" preserveAspectRatio="none" role="img" aria-label="${esc(title)}, last ${minutes} minutes">${grid}${drawn}</svg>
	<div class="chart-axis meta"><span>${minutes} min ago</span><span>now</span></div>`;
};

const sumSeries = (all: Array<number[] | undefined>, length: number): number[] => {
	const total = new Array<number>(length).fill(0);
	for (const values of all) {
		values?.forEach((value, i) => total[i] += value);
	}
	return total;
};

export const kpi = (label: string, value: string, sub: string, tone: string, spark = ''): string =>
	`<div class="kpi kpi-${tone}"><span class="kpi-label">${esc(label)}</span><span class="kpi-value">${esc(value)}</span>`
	+ `<span class="kpi-sub clip">${sub}</span>${spark}</div>`;

const kpiRow = (status: SupervisorStatus): string => {
	const { crawlers, db } = status;
	const running = crawlers.filter(crawler => crawler.state === 'running').length;
	const failed = crawlers.filter(crawler => crawler.state === 'failed').length;
	const sum = (pick: (crawler: CrawlerStatus) => number): number => crawlers.reduce((total, crawler) => total + pick(crawler), 0);
	const per429 = sum(crawler => crawler.stats?.http429PerHour ?? 0);
	const queue = db.dbStats?.queueLeft;
	return `<div class="kpis">
	${kpi('Crawlers', `${running} / ${crawlers.length}`, failed ? `${failed} failed` : 'running / total', failed ? 'bad' : running ? 'ok' : 'idle')}
	${kpi('Requests/min', number(Math.round(sum(crawler => crawler.stats?.requestsPerMin ?? 0) * 10) / 10), 'all crawlers', 'req')}
	${kpi('URLs/min', number(Math.round(sum(crawler => crawler.stats?.urlsPerMin ?? 0) * 10) / 10), 'saved and failed', 'urls')}
	${kpi('HTTP 429/hour', number(per429), per429 >= BAD_429_PER_HOUR ? 'too many, slow down' : per429 ? 'rate limited' : 'none', level429(per429) === 'ok' ? 'idle' : level429(per429))}
	${kpi('Queue left', queue ? number(queue.items) : '-', queue ? `${number(queue.accounts)} accounts` : 'unknown', 'queue', sparkline(db.queueHistory, 'queue', 'Queue left over time'))}
</div>`;
};

/** Opens the Insights view: how well the crawl fills the DB. */
const viewButton = (tone: Tone = 'ghost'): string => button('View', 'hx-get="/fragments/insights" hx-target="#insights" hx-swap="innerHTML"', false, tone);

const dbStatsLines = (db: DbStatus): string => {
	if (db.dbStatsError) {
		return `<p class="error">Statistics: ${esc(db.dbStatsError)}</p>`;
	}
	const stats = db.dbStats;
	if (!stats) {
		return '';
	}
	const queue = stats.queueLeft
		? `queue left: ${number(stats.queueLeft.items)} items, ${number(stats.queueLeft.accounts)} accounts`
		: 'queue left: unknown';
	return `<p>${queue}</p>
	<p class="meta">since start: ${number(stats.claimed)} claimed, ${number(stats.itemsSaved)} items saved, `
		+ `${number(stats.accountsSaved)} accounts saved, ${number(stats.released)} released, ${number(stats.newUrls)} new URLs</p>`;
};

const dbPanel = (db: DbStatus): string => `
<div class="panel panel-db db-${esc(db.state)}">
	<h2>DB service ${stateBadge(db.state)}</h2>
	<p class="meta">${db.url ? `URL ${esc(db.url)}` : 'not running'}${db.pid ? `, pid ${db.pid}` : ''}</p>
	${db.error ? `<p class="error">${esc(db.error)}</p>` : ''}
	${dbStatsLines(db)}
	<div class="buttons">
		${action('/fragments/db/start', 'Start', isActive(db.state), undefined, 'ok')}
		${action('/fragments/db/stop', 'Stop', !isActive(db.state), 'Stop the DB service and all crawlers?', 'warn')}
		${action('/fragments/db/restart', 'Restart')}
		${button('Logs', 'hx-get="/fragments/logs?source=db" hx-target="#logs" hx-swap="innerHTML"')}
		${viewButton()}
	</div>
</div>`;

const crawlerRow = (name: string, configured: boolean, status: CrawlerStatus, setting?: CrawlerSetting): string => {
	const base = `/fragments/crawlers/${encodeURIComponent(name)}`;
	const active = isActive(status.state);
	const logsUrl = `/fragments/logs?source=${encodeURIComponent(`crawler:${name}`)}`;
	const counts = countsText(status.counts);
	const toggle = active
		? action(`${base}/stop`, 'Stop', status.state === 'stopping', undefined, 'warn')
		: action(`${base}/start`, 'Start', !configured, undefined, 'ok');
	return `
<tr class="row-${esc(status.state)}" data-key="crawler:${esc(name)}">
	<td data-label="Name"><b class="clip" title="${esc(name)}">${esc(name)}</b>${configured ? '' : '<span class="meta clip">removed from config</span>'}</td>
	<td data-label="Settings">${setting ? `<span class="clip" title="${esc(settingsText(setting))}">${esc(settingsText(setting))}</span><span class="meta clip">${esc(proxyText(setting))}</span>` : '-'}</td>
	<td data-label="State">${stateBadge(status.state)}${status.error ? `<span class="error clip" title="${esc(status.error)}">${esc(status.error)}</span>` : ''}</td>
	<td data-label="Speed and totals">${statsText(status.stats)}<div class="meta clip" title="${esc(counts)}">${esc(counts)}</div></td>
	<td data-label="Requests/min, 30 min">${sparkline(status.series?.requests, 'req', `${name}: requests per minute, last 30 minutes`)}</td>
	<td class="actions" data-label="">
		<div class="btn-row">
			${toggle}
			${button('Logs', `hx-get="${esc(logsUrl)}" hx-target="#logs" hx-swap="innerHTML"`)}
			<details class="menu">
				<summary aria-label="More actions for ${esc(name)}">&#8943;</summary>
				<div class="menu-list">
					${action(`${base}/restart`, 'Restart', !configured)}
					${button('Edit', `hx-get="/fragments/crawler-form?name=${esc(encodeURIComponent(name))}" hx-target="#form-area" hx-swap="innerHTML"`, !configured)}
					${button('Remove', `hx-delete="${esc(base)}" hx-target="#status" hx-swap="morph" hx-confirm="Remove crawler ${esc(name)}?"`, active || !configured, 'danger')}
				</div>
			</details>
		</div>
	</td>
</tr>`;
};

/** The content of the #status block: the numbers on top, the DB service, the chart and the crawler table. */
export const renderStatus = (status: SupervisorStatus, config: AdminConfig): string => {
	const settings = new Map(config.crawlers.map(crawler => [crawler.name, crawler]));
	const rows = status.crawlers.map(crawler => crawlerRow(crawler.name, crawler.configured, crawler, settings.get(crawler.name)));
	const series = status.crawlers.map(crawler => crawler.series);
	const chart = series.some(Boolean)
		? trendChart([
			{ label: 'requests/min', tone: 'req', values: sumSeries(series.map(item => item?.requests), SERIES_BUCKETS) },
			{ label: 'URLs/min', tone: 'urls', values: sumSeries(series.map(item => item?.urls), SERIES_BUCKETS) },
			{ label: 'HTTP 429/min', tone: 'r429', values: sumSeries(series.map(item => item?.http429), SERIES_BUCKETS) },
		], SERIES_BUCKETS)
		: '<p class="meta">The chart shows up when a crawler sends its first report.</p>';
	return `
${kpiRow(status)}
${dbPanel(status.db)}
<div class="panel panel-chart">
	<h2>Speed, all crawlers</h2>
	${chart}
</div>
<div class="panel">
	<div class="panel-head">
		<h2>Crawlers</h2>
		<div class="buttons">
			${action('/fragments/all/start', 'Start all', false, undefined, 'ok')}
			${action('/fragments/all/stop', 'Stop all', false, 'Stop the DB service and all crawlers?', 'warn')}
			${viewButton('primary')}
			${button('Add crawler', 'hx-get="/fragments/crawler-form" hx-target="#form-area" hx-swap="innerHTML"')}
		</div>
	</div>
	${rows.length === 0 ? '<p class="meta">No crawlers yet.</p>' : `
	<table class="crawlers">
		<thead><tr><th>Name</th><th>Settings</th><th>State</th><th>Speed and totals</th><th>Last 30 min</th><th></th></tr></thead>
		<tbody>${rows.join('')}</tbody>
	</table>`}
</div>`;
};

export interface FormValues {
	/** The name of the crawler that is edited, empty for a new one. */
	original: string;
	name: string;
	type: string;
	reverse: boolean;
	workers: string;
	minDelayMs: string;
	maxDelayMs: string;
	idleMs: string;
	proxyKind: string;
	proxyUrl: string;
	wsHost: string;
	wsPort: string;
	wsUser: string;
	wsPassword: string;
	listIndex: string;
	listId: string;
	poolKey: string;
}

export const emptyForm = (): FormValues => ({
	original: '', name: '', type: 'item', reverse: false, workers: '', minDelayMs: '', maxDelayMs: '', idleMs: '',
	proxyKind: 'none', proxyUrl: '', wsHost: '', wsPort: '', wsUser: '', wsPassword: '', listIndex: '', listId: '', poolKey: '',
});

/** Fills the form from a setting. The caller passes a config with masked secrets. */
export const formFromSetting = (setting: CrawlerSetting): FormValues => {
	const form: FormValues = {
		...emptyForm(),
		original: setting.name,
		name: setting.name,
		type: setting.type,
		reverse: setting.reverse,
		// a value that equals the default is shown as an empty field with the default as the placeholder
		workers: setting.workers === DEFAULT_WORKERS ? '' : String(setting.workers),
		minDelayMs: setting.minDelayMs === undefined || setting.minDelayMs === MIN_REQUEST_DELAY_MS ? '' : String(setting.minDelayMs),
		maxDelayMs: setting.maxDelayMs === undefined || setting.maxDelayMs === MAX_REQUEST_DELAY_MS ? '' : String(setting.maxDelayMs),
		idleMs: setting.idleMs === undefined ? '' : String(setting.idleMs),
		proxyKind: setting.proxy.kind,
	};
	if (setting.proxy.kind === 'url') {
		form.proxyUrl = setting.proxy.url;
	} else if (setting.proxy.kind === 'webshare') {
		form.wsHost = setting.proxy.entry.host;
		form.wsPort = String(setting.proxy.entry.port);
		form.wsUser = setting.proxy.entry.username;
		form.wsPassword = setting.proxy.entry.password;
	} else if (setting.proxy.kind === 'webshare-list') {
		form.listIndex = setting.proxy.index === undefined ? '' : String(setting.proxy.index);
		form.listId = setting.proxy.id ?? '';
	} else if (setting.proxy.kind === 'pool') {
		form.poolKey = setting.proxy.key;
	}
	return form;
};

/** True when a field of the "More settings" block holds a value that is not the default. */
export const hasCustomSettings = (form: FormValues): boolean =>
	form.reverse !== DEFAULT_REVERSE
	|| (form.workers.trim() !== '' && Number(form.workers) !== DEFAULT_WORKERS)
	|| (form.minDelayMs.trim() !== '' && Number(form.minDelayMs) !== MIN_REQUEST_DELAY_MS)
	|| (form.maxDelayMs.trim() !== '' && Number(form.maxDelayMs) !== MAX_REQUEST_DELAY_MS)
	|| form.idleMs.trim() !== '';

const field = (label: string, control: string): string => `<label>${esc(label)}${control}</label>`;
const input = (name: string, value: string, extra = ''): string =>
	`<input name="${name}" value="${esc(value)}" ${extra}>`;
const select = (name: string, value: string, options: string[]): string =>
	`<select name="${name}">${options.map(option => `<option value="${option}"${option === value ? ' selected' : ''}>${option}</option>`).join('')}</select>`;

/** The select of pool entries. An entry that another crawler uses says so. */
const poolSelect = (form: FormValues, pool: PoolItem[]): string => {
	const options = pool.map(item => {
		const others = item.usedBy.filter(name => name !== form.original);
		const label = others.length ? `${item.key} (used by ${others.join(', ')})` : item.key;
		return `<option value="${esc(item.key)}"${item.key === form.poolKey ? ' selected' : ''}>${esc(label)}</option>`;
	});
	return `<select name="poolKey"><option value="">- choose -</option>${options.join('')}</select>`;
};

/** A warning when the chosen pool entry is used by another crawler. One crawler per IP is the rule. */
export const sharedPoolWarning = (key: string, crawlers: string[], self: string): string | undefined => {
	const others = crawlers.filter(name => name !== self);
	return others.length ? `Proxy ${key} is also used by ${others.join(', ')}. Use one crawler per IP.` : undefined;
};

export const renderCrawlerForm = (form: FormValues, pool: PoolItem[], error?: string): string => {
	const used = pool.find(item => item.key === form.poolKey)?.usedBy ?? [];
	const warning = form.proxyKind === 'pool' ? sharedPoolWarning(form.poolKey, used, form.original) : undefined;
	return `
<div class="modal">
<form class="panel modal-card" role="dialog" aria-modal="true" aria-labelledby="form-title" hx-post="/fragments/crawlers" hx-target="#form-area" hx-swap="innerHTML">
	<h2 id="form-title">${form.original ? `Edit crawler ${esc(form.original)}` : 'Add crawler'}</h2>
	${error ? `<p class="error">${esc(error)}</p>` : ''}
	<input type="hidden" name="original" value="${esc(form.original)}">
	<div class="grid">
		${field('Name', input('name', form.name, `required maxlength="32"${form.original ? ' readonly' : ' autofocus'}`))}
		${field('Type', select('type', form.type, ['item', 'account']))}
	</div>
	<h3>Proxy</h3>
	<div class="grid">
		${field('Proxy', select('proxyKind', form.proxyKind, ['none', 'url', 'webshare', 'webshare-list', 'pool']))}
		${field('Pool proxy (for "pool")', poolSelect(form, pool))}
		${field('Proxy URL (for "url")', input('proxyUrl', form.proxyUrl, 'placeholder="http://user:pass@host:port"'))}
		${field('Webshare host', input('wsHost', form.wsHost))}
		${field('Webshare port', input('wsPort', form.wsPort, 'type="number" min="1" max="65535"'))}
		${field('Webshare user name', input('wsUser', form.wsUser))}
		${field('Webshare password', input('wsPassword', form.wsPassword, 'type="password" autocomplete="off"'))}
		${field('Webshare list: proxy number (from 0)', input('listIndex', form.listIndex, 'type="number" min="0"'))}
		${field('Webshare list: proxy id (instead of the number)', input('listId', form.listId))}
	</div>
	<details class="more"${hasCustomSettings(form) ? ' open' : ''}>
		<summary>More settings</summary>
		<div class="grid">
			${field('Workers (1-64)', input('workers', form.workers, `type="number" min="1" max="64" placeholder="${DEFAULT_WORKERS}"`))}
			${field('Min delay, ms', input('minDelayMs', form.minDelayMs, `type="number" min="0" placeholder="${MIN_REQUEST_DELAY_MS}"`))}
			${field('Max delay, ms', input('maxDelayMs', form.maxDelayMs, `type="number" min="0" placeholder="${MAX_REQUEST_DELAY_MS}"`))}
			${field('Wait when no URLs, ms (0 = exit)', input('idleMs', form.idleMs, `type="number" min="0" placeholder="${DEFAULT_IDLE_MS}"`))}
			<label class="check"><input type="checkbox" name="reverse"${form.reverse ? ' checked' : ''}> Newest first</label>
		</div>
		<p class="meta">An empty field uses the default shown in it.</p>
	</details>
	${warning ? `<p class="warn">${esc(warning)}</p>` : ''}
	<p class="meta">Changes are used the next time the crawler starts.</p>
	<div class="buttons">
		<button type="submit" class="btn-primary">Save</button>
		<button type="button" class="btn-ghost" data-close hx-get="/fragments/crawler-form-close" hx-target="#form-area" hx-swap="innerHTML">Cancel</button>
	</div>
</form>
</div>`;
};

/** The text after an import: "N added, M updated, K skipped" and the bad lines. */
const importSummary = (result: ImportResult): string => {
	const bad = result.errors.map(item => `<li>line ${item.line}: ${esc(item.message)}</li>`).join('');
	const duplicates = result.duplicateLines.length
		? `<p class="meta">Same host:port as an earlier line, skipped: line ${result.duplicateLines.join(', ')}</p>`
		: '';
	return `<p>${result.added} added, ${result.updated} updated, ${result.skipped} skipped</p>`
		+ (bad ? `<p class="warn">Bad lines:</p><ul class="warn">${bad}</ul>` : '')
		+ duplicates;
};

/** The import form, with the result or the error of the last import. The pasted text is never shown again. */
export const renderProxyImport = (outcome?: { result?: ImportResult; error?: string }): string => `
<form class="panel" hx-post="/fragments/proxy-import" hx-target="#proxy-import" hx-swap="innerHTML">
	<h2>Proxies</h2>
	${outcome?.error ? `<p class="error banner">${esc(outcome.error)}</p>` : ''}
	${outcome?.result ? importSummary(outcome.result) : ''}
	<p class="meta">One proxy per line: host:port:username:password (the Webshare file) or http://username:password@host:port.</p>
	<div class="grid">
		<label>File (.txt)<input type="file" id="proxy-file" accept=".txt,text/plain"></label>
		<label>Mode<select name="mode">
			<option value="append" selected>append (add new, update existing)</option>
			<option value="replace">replace (the list becomes the pool)</option>
		</select></label>
	</div>
	<label>Or paste the list<textarea name="text" id="proxy-text" rows="5" autocomplete="off" spellcheck="false"></textarea></label>
	<div class="buttons">
		<button type="submit" class="btn-primary">Import</button>
	</div>
</form>`;

/** The control that adds one crawler for each free proxy, with the type of the new crawlers. */
const addCrawlersForm = (): string => `
<form class="buttons buttons-center" hx-post="/fragments/proxies/free-crawlers" hx-target="#proxy-list" hx-swap="morph">
	<label>Type of new crawlers ${select('type', 'item', ['item', 'account', 'split'])}</label>
	<button type="submit" class="btn-primary">Add crawlers for free proxies</button>
	<span class="meta">split: items and accounts in turn, items first. The crawlers are not started.</span>
</form>`;

/** The pool list. It shows host:port and the crawlers that use it, never a password. */
export const renderProxyList = (items: PoolItem[]): string => {
	const rows = items.map(item => `
<tr data-key="proxy:${esc(item.key)}" class="${item.usedBy.length > 1 ? 'row-shared' : ''}">
	<td data-label="Proxy">${esc(item.key)}</td>
	<td data-label="Used by">${item.usedBy.length ? esc(item.usedBy.join(', ')) : '<span class="meta">not used</span>'}${item.usedBy.length > 1 ? '<br><span class="warn">Many crawlers use this IP. Use one crawler per IP.</span>' : ''}</td>
	<td class="actions" data-label="">${button('Delete', `hx-delete="/fragments/proxy-list/${esc(encodeURIComponent(item.key))}" hx-target="#proxy-list" hx-swap="morph" hx-confirm="Delete proxy ${esc(item.key)}?"`, false, 'danger')}</td>
</tr>`);
	const used = items.filter(item => item.usedBy.length > 0).length;
	return `
<div class="panel">
	<h2>Proxy pool (${items.length}) <span class="meta">${used} used, ${items.length - used} free</span></h2>
	${items.length === 0 ? '' : addCrawlersForm()}
	${rows.length === 0 ? '<p class="meta">No proxies yet.</p>' : `
	<div class="scroll">
		<table class="pool">
			<thead><tr><th>Proxy</th><th>Used by</th><th></th></tr></thead>
			<tbody>${rows.join('')}</tbody>
		</table>
	</div>`}
</div>`;
};

/** The log drawer. It sits on the right side of the window, so opening it does not move the page. */
export const renderLogs = (source: string, lines: string[]): string => `
<aside class="drawer" role="dialog" aria-label="Logs: ${esc(source)}">
	<div class="drawer-head">
		<h2>Logs: ${esc(source)}</h2>
		<button type="button" class="btn-ghost" data-close hx-get="/fragments/logs-close" hx-target="#logs" hx-swap="innerHTML">Close</button>
	</div>
	<pre id="log-view" data-source="${esc(source)}">${esc(stripAnsi(lines.join('\n')))}</pre>
</aside>`;
