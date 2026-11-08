import { DEFAULT_IDLE_MS, MAX_REQUEST_DELAY_MS, MIN_REQUEST_DELAY_MS } from '@band-spider/core';
import { CrawlerSetting } from './config';
import { SERIES_BUCKETS, warningName } from './crawler-metrics';
import { CrawlerStatus } from './supervisor';
import { crawlerFailures } from './ui-failures';
import {
	action,
	button,
	bytesText,
	durationText,
	esc,
	formatNumber as number,
	HOURS_PER_MONTH,
	icon,
	iconButton,
	isActive,
	kpi,
	level429,
	logsAttrs,
	proxyText,
	rateText,
	stateBadge,
	stateDot,
	toggleButton,
	totalText,
	trendChart,
	Countries,
} from './ui-render';

const line = (label: string, value: string): string =>
	`<li class="line-row"><span class="meta">${esc(label)}</span><b>${esc(value)}</b></li>`;

const settingLines = (setting: CrawlerSetting, countries?: Countries): string => [
	line('Type', setting.type),
	line('Proxy', proxyText(setting, countries)),
	line('Workers', String(setting.workers)),
	line('Delay, ms', `${setting.minDelayMs ?? MIN_REQUEST_DELAY_MS} - ${setting.maxDelayMs ?? MAX_REQUEST_DELAY_MS}`),
	line('Wait when no URLs', setting.idleMs === 0 ? 'exits' : `${setting.idleMs ?? DEFAULT_IDLE_MS} ms`),
	line('Newest first', setting.reverse ? 'yes' : 'no'),
].join('');

const head = (name: string, extra = ''): string => `
	<div class="drawer-head">
		<h2>${extra}<span class="clip">${esc(name)}</span></h2>
		${iconButton('close', 'Close', 'data-close hx-get="/fragments/detail-close" hx-target="#detail" hx-swap="innerHTML"')}
	</div>`;

/**
 * The detail drawer of one crawler: its actions, speeds, a chart, the totals, the counts and the settings.
 * It is refreshed by the live updates while it is open. Without a status the crawler is gone.
 */
export const renderCrawlerDetail = (name: string, status: CrawlerStatus | undefined, setting: CrawlerSetting | undefined, now: number, countries?: Countries): string => {
	if (!status) {
		return `<aside class="drawer drawer-detail" role="dialog" aria-label="Crawler ${esc(name)}" data-detail="${esc(name)}">${head(name)}
		<div class="empty">${icon('info')}<p>No crawler ${esc(name)} in the config. It was removed.</p></div></aside>`;
	}
	const base = `/fragments/crawlers/${encodeURIComponent(name)}`;
	const { stats, counts, configured } = status;
	const active = isActive(status.state);
	const running = status.state === 'running';
	const pause = running && stats && stats.pauseMs > 0 ? `<p class="warn">${icon('pause')}paused after HTTP 429, ${esc(durationText(stats.pauseMs))} left</p>` : '';
	const warning = stats?.warning ? `<p class="warn">${icon('info')}${esc(warningName(stats.warning))}: ${esc(stats.warning.message)}</p>` : '';
	const idle = running && stats?.idle ? `<p class="meta">${icon('info')}waiting for URLs</p>` : '';
	const reported = stats?.reportedAt === undefined ? 'no report yet' : `last report ${durationText(Math.max(now - stats.reportedAt, 0))} ago`;
	const local = setting?.proxy.kind === 'none';
	const kpis = stats ? `
	<div class="kpis kpis-small">
		${kpi('Requests/min', rateText(stats.requestsPerMin), `${esc(number(stats.totals.requests))} total`, 'req')}
		${kpi('URLs/min', rateText(stats.urlsPerMin), `${esc(number(stats.totals.processed))} saved`, 'urls')}
		${kpi('HTTP 429/hour', number(stats.http429PerHour), `${esc(number(stats.totals.http429))} total`, level429(stats.http429PerHour) === 'ok' ? 'idle' : level429(stats.http429PerHour))}
		${kpi('New links/min', rateText(stats.linksPerMin), `${esc(number(stats.totals.newLinks))} total`, 'links')}
		${kpi('Traffic/hour', local ? '-' : bytesText(stats.bytesPerHour), local ? 'local IP, not counted' : `${esc(bytesText(stats.totals.bytes))} total, ~${esc(bytesText(stats.bytesPerHour * HOURS_PER_MONTH))}/month`, 'traffic')}
	</div>` : `<div class="empty">${icon('info')}<p>No report yet. A running crawler reports once a minute.</p></div>`;
	const chart = status.series ? `
	<div class="panel panel-inner">
		<h3>Last ${SERIES_BUCKETS} min</h3>
		${trendChart([
		{ label: 'requests/min', tone: 'req', values: status.series.requests },
		{ label: 'URLs/min', tone: 'urls', values: status.series.urls },
		{ label: 'HTTP 429/min', tone: 'r429', values: status.series.http429 },
	], SERIES_BUCKETS, `${name}: requests and URLs per minute`)}
	</div>` : '';
	const countLines = counts ? [
		line('Claimed', number(counts.claimed)),
		line('Saved', number(counts.saved)),
		line('Failed', number(counts.failed)),
		line('Rate limited', number(counts.rateLimited)),
		line('Not found', number(counts.notFound)),
	].join('') : '';
	return `
<aside class="drawer drawer-detail" role="dialog" aria-label="Crawler ${esc(name)}" data-detail="${esc(name)}">
	${head(name, stateDot(status.state))}
	<div class="detail-state">${stateBadge(status.state)}<span class="meta">${esc(reported)}${status.pid ? `, pid ${status.pid}` : ''}</span></div>
	<div class="buttons detail-actions">
		${toggleButton(base, status, configured, true)}
		${action(`${base}/restart`, 'Restart', !configured, undefined, 'ghost', 'restart')}
		${button('Logs', logsAttrs(`crawler:${name}`), false, 'ghost', 'logs')}
		${button('Edit', `hx-get="/fragments/crawler-form?name=${esc(encodeURIComponent(name))}" hx-target="#form-area" hx-swap="innerHTML"`, !configured, 'ghost', 'edit')}
		${button('Remove', `hx-delete="${esc(base)}" hx-target="#status" hx-swap="morph" hx-confirm="Remove crawler ${esc(name)}?"`, active || !configured, 'danger', 'trash')}
	</div>
	${status.error ? `<p class="error banner">${esc(status.error)}</p>` : ''}
	${configured ? '' : '<p class="warn">Removed from the config. It still runs until it is stopped.</p>'}
	${warning}${pause}${idle}
	${kpis}
	${chart}
	${stats ? crawlerFailures(stats.failures) : ''}
	<div class="detail-grid">
		${stats ? `<div class="panel panel-inner"><h3>Since start</h3><p class="meta">${esc(totalText(stats))}</p></div>` : ''}
		${countLines ? `<div class="panel panel-inner"><h3>URL counts</h3><ul class="rows plain">${countLines}</ul></div>` : ''}
		${setting ? `<div class="panel panel-inner"><h3>Settings</h3><ul class="rows plain">${settingLines(setting, countries)}</ul><p class="meta">Changes are used the next time the crawler starts.</p></div>` : ''}
	</div>
</aside>`;
};
