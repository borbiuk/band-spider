import { AdminConfig, CrawlerSetting } from './config';
import { CrawlerStats } from './crawler-metrics';
import { ChildStatus, CrawlerCounts } from './managed-child';
import { DbStatus, SupervisorStatus } from './supervisor';

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

/** A pause in ms as a short text, for example "1m 05s". */
export const durationText = (ms: number): string => {
	const seconds = Math.ceil(ms / 1000);
	return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s` : `${seconds}s`;
};

/** The speeds and totals of a crawler. */
export const statsText = (stats?: CrawlerStats): string => {
	if (!stats) {
		return '<span class="meta">no report yet</span>';
	}
	return `${stats.requestsPerMin} requests/min, ${stats.urlsPerMin} URLs/min, ${stats.http429PerHour} HTTP 429/hour`
		+ `<br><span class="meta">total: ${number(stats.totals.requests)} requests, ${number(stats.totals.processed)} saved, `
		+ `${number(stats.totals.failed)} failed, ${number(stats.totals.http429)} HTTP 429</span>`
		+ (stats.pauseMs > 0 ? `<br><span class="warn">paused after HTTP 429, ${esc(durationText(stats.pauseMs))} left</span>` : '');
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
	}
};

const button = (label: string, attrs: string, disabled = false): string =>
	`<button type="button" ${attrs}${disabled ? ' disabled' : ''}>${esc(label)}</button>`;

const action = (path: string, label: string, disabled = false, confirm?: string): string =>
	button(label, `hx-post="${esc(path)}" hx-target="#status" hx-swap="innerHTML"${confirm ? ` hx-confirm="${esc(confirm)}"` : ''}`, disabled);

const isActive = (state: string): boolean => state === 'starting' || state === 'running' || state === 'stopping';

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
<div class="panel">
	<h2>DB service ${stateBadge(db.state)}</h2>
	<p class="meta">${db.url ? `URL ${esc(db.url)}` : 'not running'}${db.pid ? `, pid ${db.pid}` : ''}</p>
	${db.error ? `<p class="error">${esc(db.error)}</p>` : ''}
	${dbStatsLines(db)}
	<div class="buttons">
		${action('/fragments/db/start', 'Start', isActive(db.state))}
		${action('/fragments/db/stop', 'Stop', !isActive(db.state), 'Stop the DB service and all crawlers?')}
		${action('/fragments/db/restart', 'Restart')}
		${button('Logs', 'hx-get="/fragments/logs?source=db" hx-target="#logs" hx-swap="innerHTML"')}
	</div>
</div>`;

const crawlerRow = (name: string, configured: boolean, status: ChildStatus, setting?: CrawlerSetting): string => {
	const base = `/fragments/crawlers/${encodeURIComponent(name)}`;
	const active = isActive(status.state);
	const logsUrl = `/fragments/logs?source=${encodeURIComponent(`crawler:${name}`)}`;
	return `
<tr>
	<td>${esc(name)}${configured ? '' : ' <span class="meta">(removed from config)</span>'}</td>
	<td>${setting ? `${esc(setting.type)}${setting.reverse ? ', reverse' : ''}, ${setting.workers} workers<br><span class="meta">${esc(proxyText(setting))}</span>` : '-'}</td>
	<td>${stateBadge(status.state)}${status.error ? `<br><span class="error">${esc(status.error)}</span>` : ''}</td>
	<td>${statsText(status.stats)}<br><span class="meta">${esc(countsText(status.counts))}</span></td>
	<td class="buttons">
		${action(`${base}/start`, 'Start', active || !configured)}
		${action(`${base}/stop`, 'Stop', !active)}
		${action(`${base}/restart`, 'Restart', !configured)}
		${button('Logs', `hx-get="${esc(logsUrl)}" hx-target="#logs" hx-swap="innerHTML"`)}
		${button('Edit', `hx-get="/fragments/crawler-form?name=${esc(encodeURIComponent(name))}" hx-target="#form-area" hx-swap="innerHTML"`, !configured)}
		${button('Remove', `hx-delete="${esc(base)}" hx-target="#status" hx-swap="innerHTML" hx-confirm="Remove crawler ${esc(name)}?"`, active || !configured)}
	</td>
</tr>`;
};

/** The content of the #status block: the DB service, the all-buttons and the crawler table. */
export const renderStatus = (status: SupervisorStatus, config: AdminConfig, error?: string): string => {
	const settings = new Map(config.crawlers.map(crawler => [crawler.name, crawler]));
	const rows = status.crawlers.map(crawler => crawlerRow(crawler.name, crawler.configured, crawler, settings.get(crawler.name)));
	return `
${error ? `<p class="error banner">${esc(error)}</p>` : ''}
${dbPanel(status.db)}
<div class="panel">
	<h2>Crawlers</h2>
	<div class="buttons">
		${action('/fragments/all/start', 'Start all')}
		${action('/fragments/all/stop', 'Stop all', false, 'Stop the DB service and all crawlers?')}
		${button('Add crawler', 'hx-get="/fragments/crawler-form" hx-target="#form-area" hx-swap="innerHTML"')}
	</div>
	${rows.length === 0 ? '<p class="meta">No crawlers yet.</p>' : `
	<table>
		<thead><tr><th>Name</th><th>Settings</th><th>State</th><th>Speed and totals</th><th></th></tr></thead>
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
	proxyKind: string;
	proxyUrl: string;
	wsHost: string;
	wsPort: string;
	wsUser: string;
	wsPassword: string;
	listIndex: string;
	listId: string;
}

export const emptyForm = (): FormValues => ({
	original: '', name: '', type: 'item', reverse: false, workers: '1', minDelayMs: '', maxDelayMs: '',
	proxyKind: 'none', proxyUrl: '', wsHost: '', wsPort: '', wsUser: '', wsPassword: '', listIndex: '', listId: '',
});

/** Fills the form from a setting. The caller passes a config with masked secrets. */
export const formFromSetting = (setting: CrawlerSetting): FormValues => {
	const form: FormValues = {
		...emptyForm(),
		original: setting.name,
		name: setting.name,
		type: setting.type,
		reverse: setting.reverse,
		workers: String(setting.workers),
		minDelayMs: setting.minDelayMs === undefined ? '' : String(setting.minDelayMs),
		maxDelayMs: setting.maxDelayMs === undefined ? '' : String(setting.maxDelayMs),
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
	}
	return form;
};

const field = (label: string, control: string): string => `<label>${esc(label)}${control}</label>`;
const input = (name: string, value: string, extra = ''): string =>
	`<input name="${name}" value="${esc(value)}" ${extra}>`;
const select = (name: string, value: string, options: string[]): string =>
	`<select name="${name}">${options.map(option => `<option value="${option}"${option === value ? ' selected' : ''}>${option}</option>`).join('')}</select>`;

export const renderCrawlerForm = (form: FormValues, error?: string): string => `
<form class="panel" hx-post="/fragments/crawlers" hx-target="#form-area" hx-swap="innerHTML">
	<h2>${form.original ? `Edit crawler ${esc(form.original)}` : 'Add crawler'}</h2>
	${error ? `<p class="error">${esc(error)}</p>` : ''}
	<input type="hidden" name="original" value="${esc(form.original)}">
	<div class="grid">
		${field('Name', input('name', form.name, `required maxlength="32"${form.original ? ' readonly' : ''}`))}
		${field('Type', select('type', form.type, ['item', 'account']))}
		${field('Workers (1-64)', input('workers', form.workers, 'type="number" min="1" max="64"'))}
		${field('Min delay, ms (optional)', input('minDelayMs', form.minDelayMs, 'type="number" min="0"'))}
		${field('Max delay, ms (optional)', input('maxDelayMs', form.maxDelayMs, 'type="number" min="0"'))}
		<label class="check"><input type="checkbox" name="reverse"${form.reverse ? ' checked' : ''}> Newest first</label>
	</div>
	<h3>Proxy</h3>
	<div class="grid">
		${field('Proxy', select('proxyKind', form.proxyKind, ['none', 'url', 'webshare', 'webshare-list']))}
		${field('Proxy URL (for "url")', input('proxyUrl', form.proxyUrl, 'placeholder="http://user:pass@host:port"'))}
		${field('Webshare host', input('wsHost', form.wsHost))}
		${field('Webshare port', input('wsPort', form.wsPort, 'type="number" min="1" max="65535"'))}
		${field('Webshare user name', input('wsUser', form.wsUser))}
		${field('Webshare password', input('wsPassword', form.wsPassword, 'type="password" autocomplete="off"'))}
		${field('Webshare list: proxy number (from 0)', input('listIndex', form.listIndex, 'type="number" min="0"'))}
		${field('Webshare list: proxy id (instead of the number)', input('listId', form.listId))}
	</div>
	<p class="meta">Changes are used the next time the crawler starts.</p>
	<div class="buttons">
		<button type="submit">Save</button>
		<button type="button" hx-get="/fragments/crawler-form-close" hx-target="#form-area" hx-swap="innerHTML">Cancel</button>
	</div>
</form>`;

export const renderLogs = (source: string, lines: string[]): string => `
<div class="panel">
	<h2>Logs: ${esc(source)}</h2>
	<pre id="log-view" data-source="${esc(source)}">${esc(stripAnsi(lines.join('\n')))}</pre>
</div>`;
