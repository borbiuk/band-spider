import { DEFAULT_IDLE_MS, MAX_REQUEST_DELAY_MS, MIN_REQUEST_DELAY_MS } from '@band-spider/core';
import { AdminConfig, CrawlerSetting, DEFAULT_REVERSE, DEFAULT_WORKERS } from './config';
import { CrawlerStats } from './crawler-metrics';
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
	icon,
	iconButton,
	isActive,
	level429,
	logsAttrs,
	postStatus,
	proxyText,
	rateText,
	settingsText,
	sparkline,
	stateDot,
	stripAnsi,
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

/** What the filter and the sort of the table read. The page script does the work, so a live update keeps the choice. */
const rowData = (name: string, status: CrawlerStatus, setting: CrawlerSetting | undefined, index: number): string => {
	const stats = status.stats;
	const pairs: Array<[string, string | number]> = [
		['index', index],
		['name', name.toLowerCase()],
		['state', status.state],
		['type', setting?.type ?? ''],
		['search', `${name} ${setting ? proxyText(setting) : ''}`.toLowerCase()],
		['requests', stats?.requestsPerMin ?? 0],
		['urls', stats?.urlsPerMin ?? 0],
		['http429', stats?.http429PerHour ?? 0],
		['saved', stats?.totals.processed ?? 0],
		['bytes', stats?.totals.bytes ?? 0],
		['links', stats?.totals.newLinks ?? 0],
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
	['http429', 'HTTP 429/hour'],
	['saved', 'saved total'],
	['bytes', 'traffic'],
	['links', 'new links'],
];

const chip = (group: string, value: string, label: string, count?: number): string =>
	`<button type="button" class="chip" data-chip="${group}" data-value="${value}" aria-pressed="false">${esc(label)}${count === undefined ? '' : ` <b>${count}</b>`}</button>`;

/** The search, the filter chips and the sort above the crawler table. Empty values mean "no filter" and "order of the config". */
const tableTools = (summary: CrawlerSummary): string => `
<div class="toolbar" data-tools>
	<label class="search">${icon('search')}<input type="search" data-filter="search" placeholder="Search name or proxy" aria-label="Search crawlers" autocomplete="off"></label>
	<div class="chips" role="group" aria-label="State">
		${chip('state', '', 'All', summary.total)}${chip('state', 'active', 'Running', summary.active)}${chip('state', 'failed', 'Failed', summary.failed)}${chip('state', 'stopped', 'Stopped', summary.stopped)}
	</div>
	<div class="chips" role="group" aria-label="Type">
		${chip('type', '', 'All types')}${chip('type', 'item', 'Items', summary.items)}${chip('type', 'account', 'Accounts', summary.accounts)}
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

/** Small labels after the name: paused, waiting, failed or removed. They sit on the name line, so the row keeps its height. */
const rowPill = (status: CrawlerStatus): string => {
	if (!status.configured) {
		return '<span class="pill pill-warn">removed from config</span>';
	}
	if (status.state === 'failed') {
		return `<span class="pill pill-bad" title="${esc(status.error ?? 'failed')}">${esc(status.error ? 'error' : 'failed')}</span>`;
	}
	// the last report of a stopped crawler can still say "paused", that is old news
	const stats = status.state === 'running' ? status.stats : undefined;
	const paused = stats && stats.pauseMs > 0
		? `<span class="pill pill-warn" title="paused after HTTP 429, ${esc(durationText(stats.pauseMs))} left">paused ${esc(durationText(stats.pauseMs))}</span>`
		: '';
	const silent = isActive(status.state) && !status.stats ? '<span class="pill">no report yet</span>' : '';
	return silent + paused + (stats?.idle ? '<span class="pill">waiting for URLs</span>' : '');
};

/** The cells of the numbers. Every cell has the same two lines, so a row keeps its height before the first report. */
const metricCells = (stats: CrawlerStats | undefined, setting: CrawlerSetting | undefined): string => {
	if (!stats) {
		return numCell('Requests/min', '-', '') + numCell('URLs/min', '-', '')
			+ numCell('HTTP 429/hour', '-', '') + numCell('New links', '-', '')
			+ numCell('Traffic', '-', setting?.proxy.kind === 'none' ? 'local IP, not counted' : '');
	}
	const level = level429(stats.http429PerHour);
	return numCell('Requests/min', rateText(stats.requestsPerMin), `${number(stats.totals.requests)} total`, '', totalText(stats))
		+ numCell('URLs/min', rateText(stats.urlsPerMin), `${number(stats.totals.processed)} saved`)
		+ numCell('HTTP 429/hour', number(stats.http429PerHour), `${number(stats.totals.http429)} total`, level === 'ok' ? '' : `lvl-${level}`)
		+ numCell('New links', number(stats.totals.newLinks), `${rateText(stats.linksPerMin)}/min`)
		+ (setting?.proxy.kind === 'none'
			? numCell('Traffic', '-', 'local IP, not counted')
			: numCell('Traffic', bytesText(stats.totals.bytes), `${bytesText(stats.bytesPerHour)}/hour`));
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

const crawlerRow = (name: string, configured: boolean, status: CrawlerStatus, setting: CrawlerSetting | undefined, index: number): string => {
	const base = `/fragments/crawlers/${encodeURIComponent(name)}`;
	const active = isActive(status.state);
	const about = setting ? `${settingsText(setting)} · ${proxyText(setting)}` : 'removed from config';
	return `
<tr class="row-${esc(status.state)}" data-key="crawler:${esc(name)}" ${rowData(name, status, setting, index)}>
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

const crawlersView = (status: SupervisorStatus, settings: Map<string, CrawlerSetting>, summary: CrawlerSummary): string => {
	const rows = status.crawlers.map((crawler, index) => crawlerRow(crawler.name, crawler.configured, crawler, settings.get(crawler.name), index));
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
			<thead><tr><th class="pick"><input type="checkbox" data-pick-all aria-label="Choose all shown crawlers"></th>${sortHead('name', 'Crawler')}${sortHead('requests', 'Req/min', 'requests per minute')}${sortHead('urls', 'URLs/min', 'URLs per minute')}${sortHead('http429', '429/hour', 'HTTP 429 answers per hour')}${sortHead('links', 'Links', 'new item-account links')}${sortHead('bytes', 'Traffic', 'traffic through the proxy')}<th>Last 30 min</th><th class="actions"><span class="sr-only">Actions</span></th></tr></thead>
			<tbody>${rows.join('')}</tbody>
		</table>
		</div>
		<div class="empty" data-no-match hidden>${icon('search')}<p>No crawler matches the filter.</p><button type="button" class="btn-ghost" data-tools-reset>Reset the filter</button></div>
	</div>
</div>`;
};

/** Numbers for the badges of the menu. The page script copies them, the menu itself is not part of a live update. */
const navSummary = (summary: CrawlerSummary, attention: number): string =>
	`<div hidden data-nav-summary data-running="${summary.running}" data-total="${summary.total}" data-failed="${summary.failed}" data-attention="${attention}"></div>`;

/** The content of the #status block: the bar on top and the live pages Overview, Crawlers and Traffic. */
export const renderStatus = (status: SupervisorStatus, config: AdminConfig, now = Date.now()): string => {
	const settings = new Map(config.crawlers.map(crawler => [crawler.name, crawler]));
	const summary = summarize(status, settings);
	const attention = attentionItems(status, config, now);
	return `
${controlBar(status.db)}
${navSummary(summary, attention.filter(item => item.tone !== 'info').length)}
${overviewView(status, attention, summary)}
${crawlersView(status, settings, summary)}
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
 * The bar that adds one crawler for each chosen proxy (the checkboxes of the list belong to this form),
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
	<button type="submit" class="btn-primary">${icon('plus')}Create crawlers for chosen proxies</button>
</form>`;

/** The crawlers of a proxy with a state dot each. A click opens the details. */
const usedByCell = (item: PoolItem, states: Map<string, CrawlerStatus>): string => {
	if (item.usedBy.length === 0) {
		return '<span class="meta">not used</span>';
	}
	const names = item.usedBy.map(name =>
		`<button type="button" class="link used-by" ${detailAttrs(name)}>${stateDot(states.get(name)?.state ?? 'stopped')}${esc(name)}</button>`).join('');
	return names + (item.usedBy.length > 1 ? '<span class="warn block">Many crawlers use this IP. Use one crawler per IP.</span>' : '');
};

/**
 * The pool list. It shows host:port, the crawlers that use it with their state and their traffic, never a password.
 * Without the status of the crawlers the states show as stopped.
 */
export const renderProxyList = (items: PoolItem[], crawlers: CrawlerStatus[] = []): string => {
	const states = new Map(crawlers.map(crawler => [crawler.name, crawler]));
	const rows = items.map((item, index) => {
		const kind = item.usedBy.length === 0 ? 'free' : item.usedBy.length > 1 ? 'shared' : 'used';
		const bytes = item.usedBy.reduce((sum, name) => sum + (states.get(name)?.stats?.totals.bytes ?? 0), 0);
		const perHour = item.usedBy.reduce((sum, name) => sum + (states.get(name)?.stats?.bytesPerHour ?? 0), 0);
		return `
	<tr data-key="proxy:${esc(item.key)}" data-pstate="${kind}" class="${kind === 'shared' ? 'row-shared' : ''}">
		<td class="pick"><input type="checkbox" form="chosen-form" name="keys" value="${esc(item.key)}" aria-label="Choose ${esc(item.key)}"${item.usedBy.length ? ' disabled' : ' data-free'}></td>
		<td class="num-col" data-label="No.">${index + 1}</td>
		<td data-label="Proxy"><b class="mono">${esc(item.key)}</b></td>
		<td data-label="Used by">${usedByCell(item, states)}</td>
		<td class="num" data-label="Traffic">${item.usedBy.length ? `<b>${esc(bytesText(bytes))}</b><span class="sub">${esc(bytesText(perHour))}/hour</span>` : '<span class="meta">-</span>'}</td>
		<td class="actions">${iconButton('trash', `Delete ${item.key}`, `hx-delete="/fragments/proxy-list/${esc(encodeURIComponent(item.key))}" hx-target="#proxy-list" hx-swap="morph" hx-confirm="Delete proxy ${esc(item.key)}?"`, item.usedBy.length > 0, 'danger')}</td>
	</tr>`;
	});
	const used = items.filter(item => item.usedBy.length > 0).length;
	const shared = items.filter(item => item.usedBy.length > 1).length;
	const free = items.length - used;
	const head = `
<div class="controlbar">
	<h1 class="page-title">Proxies</h1>
	<div class="buttons">
		<button type="button" class="${items.length ? 'btn-ghost' : 'btn-primary'}" data-open-dialog="import-dialog">${icon('upload')}Import list</button>
		${items.length === 0 ? '' : addCrawlersForm(free)}
	</div>
</div>`;
	if (rows.length === 0) {
		return `${head}
<div class="panel empty empty-big">${icon('proxies')}<h2>No proxies yet.</h2>
	<p class="meta">Import the proxy list file of Webshare, or paste a list. Then create one crawler for each proxy.</p>
	<button type="button" class="btn-primary" data-open-dialog="import-dialog">${icon('upload')}Import list</button>
</div>`;
	}
	const chip = (value: string, label: string, count: number): string =>
		`<button type="button" class="chip" data-proxy-chip="${value}" aria-pressed="false">${esc(label)} <b>${count}</b></button>`;
	return `${head}
<div class="kpis kpis-small">
	<div class="kpi kpi-idle"><span class="kpi-label">Proxies</span><span class="kpi-value">${items.length}</span><span class="kpi-sub">in the pool</span></div>
	<div class="kpi kpi-ok"><span class="kpi-label">Used</span><span class="kpi-value">${used}</span><span class="kpi-sub">by a crawler</span></div>
	<div class="kpi kpi-queue"><span class="kpi-label">Free</span><span class="kpi-value">${free}</span><span class="kpi-sub">ready for a crawler</span></div>
	<div class="kpi ${shared ? 'kpi-warn' : 'kpi-idle'}"><span class="kpi-label">Shared</span><span class="kpi-value">${shared}</span><span class="kpi-sub">more than one crawler</span></div>
</div>
<div class="panel panel-table">
	<div class="toolbar">
		<div class="chips" role="group" aria-label="Show">
			${chip('', 'All', items.length)}${chip('free', 'Free', free)}${chip('used', 'Used', used)}${chip('shared', 'Shared', shared)}
		</div>
		<span class="grow"></span>
		<span class="meta hint">Shift+click chooses a range</span>
		<button type="button" class="btn-ghost btn-small" data-select="free">${icon('check')}Select free</button>
		<button type="button" class="btn-ghost btn-small" data-select="none">Clear</button>
	</div>
	<div class="table-wrap">
		<table class="pool">
			<thead><tr><th class="pick"><span class="sr-only">Choose</span></th><th class="num-col">No.</th><th>Proxy</th><th>Used by</th><th class="num">Traffic</th><th class="actions"><span class="sr-only">Actions</span></th></tr></thead>
			<tbody>${rows.join('')}</tbody>
		</table>
	</div>
</div>
${chosenCrawlersForm()}`;
};

/** The log drawer. It sits on the right side of the window, so opening it does not move the page. */
export const renderLogs = (source: string, lines: string[]): string => `
<aside class="drawer drawer-logs" role="dialog" aria-label="Logs: ${esc(source)}">
	<div class="drawer-head">
		<h2>${icon('logs')}Logs: ${esc(source)}</h2>
		<div class="buttons">
			<label class="check meta"><input type="checkbox" data-log-follow checked> Follow</label>
			${iconButton('close', 'Close', 'data-close hx-get="/fragments/logs-close" hx-target="#logs" hx-swap="innerHTML"')}
		</div>
	</div>
	<pre id="log-view" data-source="${esc(source)}">${esc(stripAnsi(lines.join('\n')))}</pre>
</aside>`;
