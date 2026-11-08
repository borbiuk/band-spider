import { DEFAULT_IDLE_MS, MAX_REQUEST_DELAY_MS, MIN_REQUEST_DELAY_MS } from '@band-spider/core';
import { AdminConfig, CrawlerSetting, DEFAULT_REVERSE, DEFAULT_WORKERS } from './config';
import { CrawlerStats, ProxyWarning, warningName } from './crawler-metrics';
import { MIN_DONE_URLS, MIN_PEERS, ProxyPerf, ProxyVerdict, rateProxies } from './proxy-performance';
import { ImportResult, PoolItem } from './proxy-pool';
import { CrawlerStatus, DbStatus, SupervisorStatus } from './supervisor';
import { attentionItems } from './ui-attention';
import { CrawlerSummary, overviewView, summarize, trafficView } from './ui-overview';
import {
	action,
	button,
	bytesText,
	detailAttrs,
	durationText,
	esc,
	formatNumber as number,
	hasProblem,
	icon,
	iconButton,
	isActive,
	isFailing,
	level429,
	logsAttrs,
	postStatus,
	proxyText,
	rateText,
	settingsText,
	sparkline,
	stateDot,
	stripAnsi,
	BAD_429_PER_HOUR,
	countriesOf,
	Countries,
	countryLabel,
	WARN_429_PER_HOUR,
} from './ui-parts';

// the small parts are shared with the other renderers and the tests
export * from './ui-parts';

/** The DB service as a chip with a menu: its state, URL and counters, and the buttons. */
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

const dbChip = (db: DbStatus): string => `
<details class="menu db-chip db-${esc(db.state)}" data-key="db-chip">
	<summary title="DB service: ${esc(db.state)}">${stateDot(db.state)}<span>DB service</span><b>${esc(db.state)}</b>${icon('chevron')}</summary>
	<div class="menu-list popover">
		<p class="meta">${db.url ? `URL ${esc(db.url)}` : 'not running'}${db.pid ? `, pid ${db.pid}` : ''}</p>
		${db.error ? `<p class="error">${esc(db.error)}</p>` : ''}
		${dbStatsLines(db)}
		<div class="buttons">
			${action('/fragments/db/start', 'Start', isActive(db.state), undefined, 'ok', 'play')}
			${action('/fragments/db/stop', 'Stop', !isActive(db.state), 'Stop the DB service and all crawlers?', 'warn', 'stop')}
			${action('/fragments/db/restart', 'Restart', false, undefined, 'ghost', 'restart')}
			${button('Logs', logsAttrs('db'), false, 'ghost', 'logs')}
			<a class="btn-ghost" href="#insights">${icon('insights')}Insights</a>
		</div>
	</div>
</details>`;

/** The bar on top of the live pages: the page name, the DB service and the buttons for all crawlers. */
const controlBar = (db: DbStatus): string => `
<div class="controlbar">
	<h1 class="page-title"><span data-for="overview">Overview</span><span data-for="crawlers">Crawlers</span><span data-for="traffic">Traffic</span></h1>
	${dbChip(db)}
	<div class="buttons">
		${action('/fragments/all/start', 'Start all', false, undefined, 'ok', 'play')}
		${action('/fragments/all/stop', 'Stop all', false, 'Stop the DB service and all crawlers?', 'warn', 'stop')}
		${button('Add crawler', 'hx-get="/fragments/crawler-form" hx-target="#form-area" hx-swap="innerHTML"', false, 'primary', 'plus')}
	</div>
</div>`;

/** The share of the latest URLs that were saved, 0-100. Undefined before a URL was done. */
const successPercent = (stats: CrawlerStats | undefined): number | undefined =>
	stats?.failShare === undefined ? undefined : Math.round((1 - stats.failShare) * 100);

/** What the filter and the sort of the table read. The page script does the work, so a live update keeps the choice. */
const rowData = (name: string, status: CrawlerStatus, setting: CrawlerSetting | undefined, index: number, countries?: Countries): string => {
	const stats = status.stats;
	const pairs: Array<[string, string | number]> = [
		['index', index],
		['name', name.toLowerCase()],
		['state', status.state],
		['type', setting?.type ?? ''],
		['search', `${name} ${setting ? proxyText(setting, countries) : ''}`.toLowerCase()],
		['requests', stats?.requestsPerMin ?? 0],
		['urls', stats?.urlsPerMin ?? 0],
		['http429', stats?.http429PerHour ?? 0],
		['saved', stats?.totals.processed ?? 0],
		// the table shows speeds first, so the sort uses the speeds too
		['success', successPercent(stats) ?? -1],
		['bytes', stats?.bytesPerHour ?? 0],
		['links', stats?.linksPerMin ?? 0],
		['problem', hasProblem(status) ? 1 : 0],
	];
	return pairs.map(([key, value]) => `data-${key}="${esc(value)}"`).join(' ');
};

/** The sort keys of the table. The column headers and the select of narrow screens use them. */
const SORT_KEYS: Array<[string, string]> = [
	['index', 'config order'],
	['name', 'name'],
	['state', 'state'],
	['requests', 'requests/min'],
	['urls', 'URLs/min'],
	['success', 'success rate'],
	['http429', 'HTTP 429/hour'],
	['saved', 'saved total'],
	['bytes', 'traffic/hour'],
	['links', 'new links/min'],
];

const chip = (group: string, value: string, label: string, count?: number): string =>
	`<button type="button" class="chip" data-chip="${group}" data-value="${value}" aria-pressed="false">${esc(label)}${count === undefined ? '' : ` <b>${count}</b>`}</button>`;

/** The search, the filter chips and the sort above the crawler table. Empty values mean "no filter" and "order of the config". */
const tableTools = (summary: CrawlerSummary): string => `
<div class="toolbar" data-tools>
	<label class="search">${icon('search')}<input type="search" data-filter="search" placeholder="Search name or proxy" aria-label="Search crawlers" autocomplete="off"></label>
	<div class="chips" role="group" aria-label="State">
		${chip('state', '', 'All', summary.total)}${chip('state', 'active', 'Running', summary.active)}${chip('state', 'problems', 'Problems', summary.problems)}${chip('state', 'failed', 'Failed', summary.failed)}${chip('state', 'stopped', 'Stopped', summary.stopped)}
	</div>
	<div class="chips" role="group" aria-label="Type">
		${chip('type', '', 'All types', summary.total)}${chip('type', 'item', 'Items', summary.items)}${chip('type', 'account', 'Accounts', summary.accounts)}
	</div>
	<label class="sort-pick">Sort by<select data-sort-key>
		${SORT_KEYS.map(([key, label]) => `<option value="${key}">${label}</option>`).join('')}
	</select></label>
	<label class="check sort-pick"><input type="checkbox" data-sort-desc> Descending</label>
	<span class="grow"></span>
	<span class="meta" data-shown data-total="${summary.total}">${summary.total} of ${summary.total} shown</span>
	<button type="button" class="btn-ghost btn-small" data-tools-reset>Reset</button>
</div>`;

/** A number cell: the value and a small line under it. */
const numCell = (label: string, value: string, sub: string, extra = '', title = ''): string =>
	`<td class="num" data-label="${esc(label)}"${title ? ` title="${esc(title)}"` : ''}><b${extra ? ` class="${extra}"` : ''}>${esc(value)}</b><span class="sub">${esc(sub)}</span></td>`;

/** The total line of a crawler. It is the tooltip of the speed and a line of the details. */
export const totalText = (stats: CrawlerStats): string =>
	`total: ${number(stats.totals.requests)} requests, ${number(stats.totals.processed)} saved, `
	+ `${number(stats.totals.failed)} failed, ${number(stats.totals.http429)} HTTP 429`;

/** The label of a proxy warning. It stays after the crawler stopped, until the next start. */
const warningPill = (warning: ProxyWarning | undefined): string =>
	warning ? `<span class="pill pill-bad" title="${esc(warning.message)}">${esc(warningName(warning))}</span>` : '';

/** Small labels after the name: paused, waiting, failed or removed. They sit on the name line, so the row keeps its height. */
const rowPill = (status: CrawlerStatus): string => {
	if (!status.configured) {
		return '<span class="pill pill-warn">removed from config</span>';
	}
	const warning = warningPill(status.stats?.warning);
	if (status.state === 'failed') {
		return `<span class="pill pill-bad" title="${esc(status.error ?? 'failed')}">${esc(status.error ? 'error' : 'failed')}</span>${warning}`;
	}
	// the last report of a stopped crawler can still say "paused", that is old news
	const stats = status.state === 'running' ? status.stats : undefined;
	const paused = stats && stats.pauseMs > 0
		? `<span class="pill pill-warn" title="paused after HTTP 429, ${esc(durationText(stats.pauseMs))} left">paused ${esc(durationText(stats.pauseMs))}</span>`
		: '';
	const failing = isFailing(status)
		? `<span class="pill pill-bad" title="${esc(`${Math.round((stats?.failShare ?? 0) * 100)}% of the latest URLs failed, ${rateText(stats?.failedPerMin ?? 0)} per minute. The proxy may be blocked.`)}">errors ${Math.round((stats?.failShare ?? 0) * 100)}%</span>`
		: '';
	const silent = isActive(status.state) && !status.stats ? '<span class="pill">no report yet</span>' : '';
	return warning + failing + silent + paused + (stats?.idle ? '<span class="pill">waiting for URLs</span>' : '');
};

/**
 * The cells of the numbers. Every cell has the same two lines, so a row keeps its height before the first report.
 * The first line is always a speed or a share of now, the second line is the total since the start.
 */
const metricCells = (stats: CrawlerStats | undefined, setting: CrawlerSetting | undefined): string => {
	const local = setting?.proxy.kind === 'none';
	if (!stats) {
		return numCell('Requests/min', '-', '') + numCell('URLs/min', '-', '') + numCell('Success', '-', '')
			+ numCell('HTTP 429/hour', '-', '') + numCell('Links/min', '-', '')
			+ numCell('Traffic/hour', '-', local ? 'local IP, not counted' : '');
	}
	const level = level429(stats.http429PerHour);
	const success = successPercent(stats);
	const successLevel = success === undefined ? '' : success < 50 ? 'lvl-bad' : success < 90 ? 'lvl-warn' : '';
	return numCell('Requests/min', rateText(stats.requestsPerMin), `${number(stats.totals.requests)} total`, '', totalText(stats))
		+ numCell('URLs/min', rateText(stats.urlsPerMin), `${number(stats.totals.processed)} saved`)
		+ numCell('Success', success === undefined ? '-' : `${success}%`, `${number(stats.totals.failed)} failed`, successLevel, 'Share of the latest URLs that were saved')
		+ numCell('HTTP 429/hour', number(stats.http429PerHour), `${number(stats.totals.http429)} total`, level === 'ok' ? '' : `lvl-${level}`)
		+ numCell('Links/min', rateText(stats.linksPerMin), `${number(stats.totals.newLinks)} total`)
		+ (local
			? numCell('Traffic/hour', '-', 'local IP, not counted')
			: numCell('Traffic/hour', bytesText(stats.bytesPerHour), `${bytesText(stats.totals.bytes)} total`));
};

/** The start or stop button of a crawler, as an icon. */
export const toggleButton = (base: string, status: CrawlerStatus, configured: boolean, withText = false): string => {
	const active = isActive(status.state);
	if (withText) {
		return active
			? action(`${base}/stop`, 'Stop', status.state === 'stopping', undefined, 'warn', 'stop')
			: action(`${base}/start`, 'Start', !configured, undefined, 'ok', 'play');
	}
	return active
		? iconButton('stop', 'Stop', postStatus(`${base}/stop`), status.state === 'stopping', 'warn')
		: iconButton('play', 'Start', postStatus(`${base}/start`), !configured, 'ok');
};

const crawlerRow = (name: string, configured: boolean, status: CrawlerStatus, setting: CrawlerSetting | undefined, index: number, countries?: Countries): string => {
	const base = `/fragments/crawlers/${encodeURIComponent(name)}`;
	const active = isActive(status.state);
	const about = setting ? `${settingsText(setting)} · ${proxyText(setting, countries)}` : 'removed from config';
	return `
<tr class="row-${esc(status.state)}${isFailing(status) ? ' row-failing' : ''}" data-key="crawler:${esc(name)}" ${rowData(name, status, setting, index, countries)}>
	<td class="pick"><input type="checkbox" name="names" value="${esc(name)}" form="bulk-form" aria-label="Choose ${esc(name)}"></td>
	<td class="name-cell" data-label="Crawler">
		<div class="name-line">${stateDot(status.state)}<button type="button" class="link name" title="Details of ${esc(name)}" ${detailAttrs(name)}>${esc(name)}</button>${rowPill(status)}</div>
		<span class="sub clip" title="${esc(about)}">${esc(about)}</span>
	</td>
	${metricCells(status.stats, setting)}
	<td class="spark-cell" data-label="Last 30 min">${sparkline(status.series?.requests, 'req', `${name}: requests per minute, last 30 minutes`)}</td>
	<td class="actions">
		<div class="row-actions">
			${toggleButton(base, status, configured)}
			${iconButton('logs', 'Logs', logsAttrs(`crawler:${name}`))}
			<details class="menu">
				<summary class="btn-icon" title="More" aria-label="More actions for ${esc(name)}">${icon('more')}</summary>
				<div class="menu-list">
					${button('Details', detailAttrs(name), false, 'ghost', 'panel')}
					${action(`${base}/restart`, 'Restart', !configured, undefined, 'ghost', 'restart')}
					${button('Edit', `hx-get="/fragments/crawler-form?name=${esc(encodeURIComponent(name))}" hx-target="#form-area" hx-swap="innerHTML"`, !configured, 'ghost', 'edit')}
					${button('Remove', `hx-delete="${esc(base)}" hx-target="#status" hx-swap="morph" hx-confirm="Remove crawler ${esc(name)}?"`, active || !configured, 'danger', 'trash')}
				</div>
			</details>
		</div>
	</td>
</tr>`;
};

const sortHead = (key: string, label: string, title = label): string =>
	`<th data-sort-col="${key}"><button type="button" class="th-sort" data-sort="${key}" title="Sort by ${esc(title)}">${esc(label)}${icon('sort')}</button></th>`;

const crawlersView = (status: SupervisorStatus, settings: Map<string, CrawlerSetting>, summary: CrawlerSummary, countries: Countries): string => {
	const rows = status.crawlers.map((crawler, index) => crawlerRow(crawler.name, crawler.configured, crawler, settings.get(crawler.name), index, countries));
	if (rows.length === 0) {
		return `
<div class="view" data-view="crawlers">
	<div class="panel empty empty-big">${icon('crawlers')}<h2>No crawlers yet.</h2>
		<p class="meta">A crawler is one process with one proxy. Add one by hand, or import proxies and create one crawler for each.</p>
		<div class="buttons">${button('Add crawler', 'hx-get="/fragments/crawler-form" hx-target="#form-area" hx-swap="innerHTML"', false, 'primary', 'plus')}<a class="btn-ghost" href="#proxies">${icon('proxies')}Open proxies</a></div>
	</div>
</div>`;
	}
	return `
<div class="view" data-view="crawlers">
	<div class="panel panel-table">
		${tableTools(summary)}
		<div class="table-wrap">
		<table class="crawlers">
			<thead><tr><th class="pick"><input type="checkbox" data-pick-all aria-label="Choose all shown crawlers"></th>${sortHead('name', 'Crawler')}${sortHead('requests', 'Req/min', 'requests per minute')}${sortHead('urls', 'URLs/min', 'URLs per minute')}${sortHead('success', 'Success', 'share of the latest URLs that were saved')}${sortHead('http429', '429/hour', 'HTTP 429 answers per hour')}${sortHead('links', 'Links/min', 'new item-account links per minute')}${sortHead('bytes', 'Traffic/hour', 'traffic through the proxy per hour')}<th>Last 30 min</th><th class="actions"><span class="sr-only">Actions</span></th></tr></thead>
			<tbody data-keep-order>${rows.join('')}</tbody>
		</table>
		</div>
		<div class="empty" data-no-match hidden>${icon('search')}<p>No crawler matches the filter.</p><button type="button" class="btn-ghost" data-tools-reset>Reset the filter</button></div>
	</div>
</div>`;
};

/** Numbers for the badges of the menu. The page script copies them, the menu itself is not part of a live update. */
const navSummary = (summary: CrawlerSummary, attention: number): string =>
	`<div hidden data-nav-summary data-running="${summary.active}" data-total="${summary.total}" data-failed="${summary.failed}" data-attention="${attention}"></div>`;

/** The content of the #status block: the bar on top and the live pages Overview, Crawlers and Traffic. */
export const renderStatus = (status: SupervisorStatus, config: AdminConfig, now = Date.now()): string => {
	const settings = new Map(config.crawlers.map(crawler => [crawler.name, crawler]));
	const summary = summarize(status, settings);
	const attention = attentionItems(status, now);
	return `
${controlBar(status.db)}
${navSummary(summary, attention.filter(item => item.tone !== 'info').length)}
${overviewView(status, attention, summary)}
${crawlersView(status, settings, summary, countriesOf(config.proxyPool))}
${trafficView(status, settings)}`;
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

const field = (label: string, control: string, kind = ''): string =>
	`<label${kind ? ` data-for-kind="${kind}"` : ''}>${esc(label)}${control}</label>`;
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

export const renderCrawlerForm = (form: FormValues, pool: PoolItem[], error?: string): string => {
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
		${field('Pool proxy', poolSelect(form, pool), 'pool')}
		${field('Proxy URL', input('proxyUrl', form.proxyUrl, 'placeholder="http://user:pass@host:port"'), 'url')}
		${field('Webshare host', input('wsHost', form.wsHost), 'webshare')}
		${field('Webshare port', input('wsPort', form.wsPort, 'type="number" min="1" max="65535"'), 'webshare')}
		${field('Webshare user name', input('wsUser', form.wsUser), 'webshare')}
		${field('Webshare password', input('wsPassword', form.wsPassword, 'type="password" autocomplete="off"'), 'webshare')}
		${field('Webshare list: proxy number (from 0)', input('listIndex', form.listIndex, 'type="number" min="0"'), 'webshare-list')}
		${field('Webshare list: proxy id (instead of the number)', input('listId', form.listId), 'webshare-list')}
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
	return `<div class="notice-ok">${icon('check')}<p>${result.added} added, ${result.updated} updated, ${result.skipped} skipped</p></div>`
		+ (bad ? `<p class="warn">Bad lines:</p><ul class="warn">${bad}</ul>` : '')
		+ duplicates;
};

/** The import form, with the result or the error of the last import. The pasted text is never shown again. It lives in a dialog. */
export const renderProxyImport = (outcome?: { result?: ImportResult; error?: string }): string => `
<form class="dialog-card" hx-post="/fragments/proxy-import" hx-target="#proxy-import" hx-swap="innerHTML">
	<div class="drawer-head">
		<h2 id="import-title">Import proxies</h2>
		${iconButton('close', 'Close', 'data-dialog-close')}
	</div>
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
	<label>Or paste the list<textarea name="text" id="proxy-text" rows="6" autocomplete="off" spellcheck="false"></textarea></label>
	<div class="buttons buttons-end">
		<button type="button" class="btn-ghost" data-dialog-close>Close</button>
		<button type="submit" class="btn-primary">${icon('upload')}Import</button>
	</div>
</form>`;

/** The control that adds one crawler for each free proxy, with the type of the new crawlers. It sits in a menu. */
const addCrawlersForm = (free: number): string => `
<details class="menu" data-key="free-menu">
	<summary class="btn-ghost">${icon('plus')}Add crawlers for free proxies${icon('chevron')}</summary>
	<div class="menu-list popover popover-right">
		<form class="stack" hx-post="/fragments/proxies/free-crawlers" hx-target="#proxy-list" hx-swap="morph">
			<label>Type of new crawlers ${`<select name="type">${['item', 'account', 'split'].map(option => `<option value="${option}"${option === 'item' ? ' selected' : ''}>${option}</option>`).join('')}</select>`}</label>
			<p class="meta">One crawler for each of the ${free} free proxies. split: items and accounts in turn, items first. The crawlers are not started.</p>
			<button type="submit" class="btn-primary"${free === 0 ? ' disabled' : ''}>Add crawlers for free proxies</button>
		</form>
	</div>
</details>`;

/**
 * The bar that adds one crawler for each chosen proxy, free or used (the checkboxes of the list belong to this form),
 * with the type of the new crawlers and the choice to start them. It shows only while a proxy is chosen.
 */
const chosenCrawlersForm = (): string => `
<form id="chosen-form" class="actionbar" hx-post="/fragments/proxies/chosen-crawlers" hx-target="#proxy-list" hx-swap="morph" aria-label="Create crawlers for the chosen proxies">
	<span class="actionbar-count"><b data-selected-count>0</b> chosen</span>
	<div class="seg" role="radiogroup" aria-label="Type of new crawlers">
		<label><input type="radio" name="type" value="item" checked><span>item</span></label>
		<label><input type="radio" name="type" value="account"><span>account</span></label>
	</div>
	<label class="check"><input type="checkbox" name="start" value="1" checked> Start right away</label>
	<span class="grow"></span>
	<button type="button" class="btn-ghost" data-select="none">Clear</button>
	<button type="button" class="btn-danger" hx-post="/fragments/proxies/delete-chosen" hx-confirm="Delete the chosen proxies? Proxies that crawlers use are kept.">${icon('trash')}Delete chosen</button>
	<button type="submit" class="btn-primary">${icon('plus')}Create crawlers for chosen proxies</button>
</form>`;

/** The question before the whole pool is deleted. */
const deleteAllQuestion = (total: number, used: number): string => used === 0
	? `Delete all ${total} proxies?`
	: `Delete all ${total - used} free proxies? ${used} used by crawlers are kept.`;

/** The crawlers of a proxy with a state dot each. A click opens the details. */
const usedByCell = (item: PoolItem, states: Map<string, CrawlerStatus>): string => {
	if (item.usedBy.length === 0) {
		return '<span class="meta">not used</span>';
	}
	const names = item.usedBy.map(name =>
		`<button type="button" class="link used-by" ${detailAttrs(name)}>${stateDot(states.get(name)?.state ?? 'stopped')}${esc(name)}</button>`).join('');
	return names;
};

/**
 * The pool list. It shows host:port, the crawlers that use it with their state and their traffic, never a password.
 * Without the status of the crawlers the states show as stopped.
 */
export const renderProxyList = (items: PoolItem[], crawlers: CrawlerStatus[] = []): string => {
	const states = new Map(crawlers.map(crawler => [crawler.name, crawler]));
	const perfs = rateProxies(items, crawlers);
	const perfOf = (item: PoolItem): ProxyPerf => perfs.get(item.key)!;
	// the order of the verdict sort: what needs a look comes first
	const VERDICT_ORDER: Record<ProxyVerdict, number> = { replace: 0, slow: 1, idle: 2, learning: 3, ok: 4, best: 5, free: 6 };
	const VERDICT_TEXT: Record<ProxyVerdict, string> = { replace: 'Replace', slow: 'Slow', idle: 'Not running', learning: 'Collecting data', ok: 'OK', best: 'Best', free: 'Free' };

	const rows = items.map((item, index) => {
		const kind = item.usedBy.length === 0 ? 'free' : item.usedBy.length > 1 ? 'shared' : 'used';
		const perf = perfOf(item);
		const country = item.countryCode ? countryLabel(item.countryCode) : '';
		const place = perf.rank !== undefined ? ` <span class="rank">#${perf.rank}</span>` : '';
		const success = perf.successPercent;
		const pageCost = perf.bytesPer1000Pages === undefined ? '' : `${bytesText(perf.bytesPer1000Pages)} per 1,000 saved pages`;
		return `
	<tr data-key="proxy:${esc(item.key)}" data-pstate="${kind}" data-verdict="${perf.verdict}" data-index="${index}" data-search="${esc(`${item.key} ${item.usedBy.join(' ')} ${country} ${item.countryCode ?? ''}`.toLowerCase())}" data-country="${esc(country.toLowerCase())}" data-verdict-order="${VERDICT_ORDER[perf.verdict]}" data-rank="${perf.rank ?? 100000}" data-perf="${perf.savedPerMin ?? -1}" data-success="${success ?? -1}" data-r429="${perf.http429PerHour}" data-bytes="${perf.bytesPerHour}"${perf.verdict === 'replace' ? ' class="row-failing"' : ''}>
		<td class="pick"><input type="checkbox" form="chosen-form" name="keys" value="${esc(item.key)}" aria-label="Choose ${esc(item.key)}"${item.usedBy.length ? '' : ' data-free'}></td>
		<td data-label="Proxy"><b class="mono">${esc(item.key)}</b></td>
		<td data-label="Country" class="country">${country ? `<span title="${esc(item.countryCode ?? '')}">${esc(country)}</span>` : '<span class="meta" title="Use Detect countries">-</span>'}</td>
		<td data-label="Used by">${usedByCell(item, states)}</td>
		<td data-label="Verdict"><span class="pill pill-${perf.verdict}" title="${esc(perf.reason)}">${VERDICT_TEXT[perf.verdict]}${place}</span></td>
		<td class="num" data-label="Saved/min" title="Saved pages per minute, the last 5 minutes. Failed URLs are not counted.">${perf.savedPerMin === undefined ? '<span class="meta">-</span>' : `<b>${rateText(perf.savedPerMin)}</b><span class="sub">${rateText(perf.requestsPerMin ?? 0)} req/min</span>`}</td>
		<td class="num" data-label="Success">${success === undefined ? '<span class="meta">-</span>' : `<b${success < 50 ? ' class="lvl-bad"' : success < 90 ? ' class="lvl-warn"' : ''}>${success}%</b><span class="sub">latest URLs</span>`}</td>
		<td class="num" data-label="HTTP 429/hour">${item.usedBy.length ? `<b${perf.http429PerHour >= BAD_429_PER_HOUR ? ' class="lvl-bad"' : perf.http429PerHour >= WARN_429_PER_HOUR ? ' class="lvl-warn"' : ''}>${number(perf.http429PerHour)}</b>` : '<span class="meta">-</span>'}</td>
		<td class="num" data-label="Traffic/hour"${pageCost ? ` title="${esc(pageCost)}"` : ''}>${item.usedBy.length ? `<b>${esc(bytesText(perf.bytesPerHour))}</b><span class="sub">${esc(bytesText(perf.bytesTotal))} total</span>` : '<span class="meta">-</span>'}</td>
		<td class="actions">${iconButton('trash', item.usedBy.length > 0 ? `Cannot delete ${item.key}: used by ${item.usedBy.join(', ')}. Remove the crawler first.` : `Delete ${item.key}`, `hx-delete="/fragments/proxy-list/${esc(encodeURIComponent(item.key))}" hx-target="#proxy-list" hx-swap="morph" hx-confirm="Delete proxy ${esc(item.key)}?"`, item.usedBy.length > 0, 'danger')}</td>
	</tr>`;
	});
	const used = items.filter(item => item.usedBy.length > 0).length;
	const psort = (key: string, label: string, numeric = false, title = label): string =>
		`<th${numeric ? ' class="num"' : ''}><button type="button" class="th-sort" data-psort="${key}" title="Sort by ${esc(title)}">${esc(label)}${icon('sort')}</button></th>`;
	const shared = items.filter(item => item.usedBy.length > 1).length;
	const free = items.length - used;
	const count = (verdict: ProxyVerdict): number => items.filter(item => perfOf(item).verdict === verdict).length;
	const head = `
<div class="controlbar">
	<h1 class="page-title">Proxies</h1>
	<div class="buttons">
		<button type="button" class="${items.length ? 'btn-ghost' : 'btn-primary'}" data-open-dialog="import-dialog">${icon('upload')}Import list</button>
		${items.length === 0 ? '' : `<button type="button" class="btn-ghost" hx-post="/fragments/proxies/detect-countries" hx-target="#proxy-list" hx-swap="morph" title="Asks the Webshare API for the country of each proxy. It needs WEBSHARE_API_KEY in the .env file.">${icon('proxies')}Detect countries</button>`}
		${items.length === 0 ? '' : addCrawlersForm(free)}
		${items.length === 0 ? '' : `<button type="button" class="btn-danger" hx-post="/fragments/proxies/delete-all" hx-target="#proxy-list" hx-swap="morph" hx-confirm="${esc(deleteAllQuestion(items.length, used))}">${icon('trash')}Delete all</button>`}
	</div>
</div>`;
	if (rows.length === 0) {
		return `${head}
<div class="panel empty empty-big">${icon('proxies')}<h2>No proxies yet.</h2>
	<p class="meta">Import the proxy list file of Webshare, or paste a list. Then create one crawler for each proxy.</p>
	<button type="button" class="btn-primary" data-open-dialog="import-dialog">${icon('upload')}Import list</button>
</div>`;
	}
	const chip = (value: string, label: string, total: number, hint: string): string =>
		`<button type="button" class="chip" data-proxy-chip="${value}" aria-pressed="false" title="${esc(hint)}">${esc(label)} <b>${total}</b></button>`;
	return `${head}
${proxyInsights(items, perfs)}
<div class="panel panel-table">
	<div class="toolbar">
		<div class="chips" role="group" aria-label="Show">
			${chip('', 'All', items.length, 'All proxies of the pool')}${chip('free', 'Free', free, 'No crawler uses them. Ready for a new crawler.')}${chip('used', 'Used', used, 'At least one crawler uses them. Shared ones are included.')}${chip('shared', 'Shared', shared, 'More than one crawler uses them. This is a part of Used.')}
		</div>
		<div class="chips" role="group" aria-label="Performance">
			${chip('replace', 'Replace', count('replace'), 'Blocked, rate limited, with a warning, or with a failed crawler')}${chip('slow', 'Slow', count('slow'), 'Saves less than half of the median speed')}${chip('best', 'Best', count('best'), 'The fastest healthy proxies')}
		</div>
		<label class="search">${icon('search')}<input type="search" data-proxy-search placeholder="Search proxy, country or crawler" aria-label="Search proxies" autocomplete="off"></label>
		<span class="grow"></span>
		<span class="meta hint">Shift+click chooses a range</span>
		<button type="button" class="btn-ghost btn-small" data-select="all">${icon('check')}Select all</button>
		<button type="button" class="btn-ghost btn-small" data-select="free">${icon('check')}Select free</button>
		<button type="button" class="btn-ghost btn-small" data-select="none">Clear</button>
	</div>
	<div class="table-wrap">
		<table class="pool">
			<thead><tr><th class="pick"><span class="sr-only">Choose</span></th><th>Proxy</th>${psort('country', 'Country')}<th>Used by</th>${psort('verdict-order', 'Verdict')}${psort('perf', 'Saved/min', true, 'saved pages per minute')}${psort('success', 'Success', true)}${psort('r429', '429/hour', true)}${psort('bytes', 'Traffic/hour', true)}<th class="actions"><span class="sr-only">Actions</span></th></tr></thead>
			<tbody data-keep-order>${rows.join('')}</tbody>
		</table>
	</div>
</div>
${chosenCrawlersForm()}`;
};

/** A list line of the insight panels: place, flag, proxy, and a short number or reason. */
const insightRow = (item: PoolItem, perf: ProxyPerf, text: string): string =>
	`<li><span class="rank">${perf.rank !== undefined ? `#${perf.rank}` : ''}</span><span class="mono">${esc(item.key)}</span>`
	+ `<span class="country-small">${esc(item.countryCode ? countryLabel(item.countryCode) : '')}</span><span class="meta clip" title="${esc(perf.reason)}">${esc(text)}</span></li>`;

const INSIGHT_ROWS = 5;

/**
 * Three small panels above the table: the best proxies, the ones to replace or check, and the speed by country.
 * The numbers come from the crawlers that use the proxies, so a proxy without a running crawler has none.
 */
const proxyInsights = (items: PoolItem[], perfs: Map<string, ProxyPerf>): string => {
	const entries = items.map(item => ({ item, perf: perfs.get(item.key)! }));
	const best = entries.filter(entry => entry.perf.verdict === 'best' || entry.perf.verdict === 'ok')
		.sort((a, b) => (a.perf.rank ?? 0) - (b.perf.rank ?? 0)).slice(0, INSIGHT_ROWS);
	const bad = entries.filter(entry => entry.perf.verdict === 'replace' || entry.perf.verdict === 'slow')
		.sort((a, b) => (a.perf.verdict === b.perf.verdict ? (a.perf.savedPerMin ?? 0) - (b.perf.savedPerMin ?? 0) : a.perf.verdict === 'replace' ? -1 : 1));
	const rated = entries.filter(entry => entry.perf.rank !== undefined).length;

	const bestBody = best.length === 0
		? `<div class="empty">${icon('info')}<p>No ranking yet. A proxy is rated after ${MIN_DONE_URLS} URLs, and the ranking needs ${MIN_PEERS} rated proxies.</p></div>`
		: `<ul class="insight-rows">${best.map(({ item, perf }) => insightRow(item, perf, `${rateText(perf.savedPerMin ?? 0)} pages/min, ${perf.successPercent ?? '-'}%`)).join('')}</ul>`;
	const badBody = bad.length === 0
		? `<div class="empty empty-ok">${icon('check')}<p>${rated === 0 ? 'Nothing to replace yet.' : 'No proxy needs replacing.'}</p></div>`
		: `<ul class="insight-rows">${bad.slice(0, INSIGHT_ROWS).map(({ item, perf }) => insightRow(item, perf, perf.reason)).join('')}</ul>`
			+ (bad.length > INSIGHT_ROWS ? `<p class="meta">and ${bad.length - INSIGHT_ROWS} more. <button type="button" class="link" data-proxy-chip="replace">Show in the table</button></p>` : '');

	// the speed by country: the mean saved pages per minute of the rated proxies of each country
	const byCountry = new Map<string, { code: string; proxies: number; speed: number; success: number[] }>();
	for (const { item, perf } of entries) {
		if (!item.countryCode || perf.savedPerMin === undefined || perf.rank === undefined) {
			continue;
		}
		const row = byCountry.get(item.countryCode) ?? { code: item.countryCode, proxies: 0, speed: 0, success: [] };
		row.proxies++;
		row.speed += perf.savedPerMin;
		if (perf.successPercent !== undefined) {
			row.success.push(perf.successPercent);
		}
		byCountry.set(item.countryCode, row);
	}
	const countries = [...byCountry.values()].sort((a, b) => b.speed / b.proxies - a.speed / a.proxies);
	const known = items.filter(item => item.countryCode).length;
	const countryBody = countries.length === 0
		? `<div class="empty">${icon('info')}<p>${known === 0 ? 'No countries yet. Put WEBSHARE_API_KEY in the .env file, restart the admin, then press Detect countries.' : 'No country has rated proxies yet.'}</p></div>`
		: `<ul class="insight-rows country-rows">${countries.slice(0, INSIGHT_ROWS).map(row =>
			`<li><span class="country-small">${esc(countryLabel(row.code))}</span><span class="meta">${row.proxies} ${row.proxies === 1 ? 'proxy' : 'proxies'}</span>`
			+ `<b>${rateText(row.speed / row.proxies)}</b><span class="meta">pages/min each, ${row.success.length ? Math.round(row.success.reduce((a, b) => a + b, 0) / row.success.length) : '-'}% success</span></li>`).join('')}</ul>`
			+ `<p class="meta">${known} of ${items.length} proxies have a country.</p>`;

	return `<div class="cols cols-3">
	<div class="panel"><div class="panel-head"><h2>Best proxies</h2><span class="meta">by saved pages per minute</span></div>${bestBody}</div>
	<div class="panel"><div class="panel-head"><h2>Replace or check ${bad.length ? `<span class="count count-bad">${bad.length}</span>` : ''}</h2><span class="meta">blocked, rate limited or slow</span></div>${badBody}</div>
	<div class="panel"><div class="panel-head"><h2>By country</h2><span class="meta">mean speed of one proxy</span></div>${countryBody}</div>
</div>
<p class="meta perf-note">The speed also depends on the settings of the crawler (workers, delay), so compare proxies whose crawlers are set alike. The numbers start again when a crawler starts.</p>`;
};

/** The log drawer. It sits on the right side of the window, so opening it does not move the page. */
export const renderLogs = (source: string, lines: string[]): string => `
<aside class="drawer drawer-logs" role="dialog" aria-label="Logs: ${esc(source)}">
	<div class="drawer-head">
		<h2>${icon('logs')}Logs: ${esc(source)}</h2>
		<div class="buttons">
			<label class="search search-small">${icon('search')}<input type="search" data-log-filter placeholder="Filter lines" aria-label="Filter log lines" autocomplete="off"></label>
			<button type="button" class="btn-ghost btn-small" data-log-copy title="Copy the shown lines">Copy</button>
			<label class="check meta"><input type="checkbox" data-log-follow checked> Follow</label>
			${iconButton('close', 'Close', 'data-close hx-get="/fragments/logs-close" hx-target="#logs" hx-swap="innerHTML"')}
		</div>
	</div>
	<pre id="log-view" data-source="${esc(source)}">${esc(stripAnsi(lines.join('\n')))}</pre>
</aside>`;
