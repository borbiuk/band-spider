import { FailureReason } from './crawler-metrics';
import { SupervisorStatus } from './supervisor';
import { esc, formatNumber as number, icon, shareBar } from './ui-parts';

type Failure = FailureReason & { key: string };

const STATUS_NAMES: Record<number, string> = {
	400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 407: 'Proxy Authentication Required',
	408: 'Request Timeout', 410: 'Gone', 451: 'Unavailable For Legal Reasons', 500: 'Internal Server Error', 502: 'Bad Gateway',
	503: 'Service Unavailable', 504: 'Gateway Timeout',
};

const statusText = (status: string): string => {
	const name = STATUS_NAMES[Number(status)];
	return name ? `${status} ${name}` : status;
};

/** A readable name of a failure key, for example `http:503` is "HTTP 503 Service Unavailable". */
export const failureLabel = (key: string): string => {
	const [kind, detail = ''] = key.split(/:(.*)/s);
	switch (kind) {
		case 'http': return `HTTP ${statusText(detail)}`;
		case 'api': return detail ? `Bandcamp API refused, HTTP ${statusText(detail)}` : 'Bandcamp API refused';
		case 'network': return `Network error ${detail}`;
		case 'timeout': return 'Request timeout';
		case 'not-found': return 'Page not found';
		case 'save': return 'Saving to the DB failed';
		case 'scrape': return 'Page could not be read';
		case 'other': return 'Other reasons';
		default: return key;
	}
};

/** Adds the reasons of several crawlers: the counts are added, the example is the one of the biggest crawler count. */
export const mergeFailures = (lists: ReadonlyArray<readonly Failure[] | undefined>): Failure[] => {
	const merged = new Map<string, Failure & { top: number }>();
	for (const list of lists) {
		for (const reason of list ?? []) {
			const entry = merged.get(reason.key);
			if (!entry) {
				merged.set(reason.key, { ...reason, top: reason.count });
				continue;
			}
			entry.count += reason.count;
			if (reason.count > entry.top) {
				entry.top = reason.count;
				entry.last = reason.last;
			}
		}
	}
	return [...merged.values()]
		.map(({ top: _top, ...reason }) => reason)
		.sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
};

/** The failure reasons as rows: the name, a bar with the share, and the count. */
export const failureRows = (failures: readonly Failure[], showExample: boolean): string => {
	const sum = failures.reduce((all, reason) => all + reason.count, 0);
	return `<ul class="rows failure-rows">${failures.map(reason => {
		const share = sum > 0 ? (reason.count / sum) * 100 : 0;
		const label = failureLabel(reason.key);
		return `<li data-key="failure:${esc(reason.key)}" title="${esc(reason.last)}">
			<span class="row-label clip">${esc(label)}</span>
			${shareBar(share, 'bad', `${label}: ${Math.round(share)}% of the errors`)}
			<span class="row-value"><b>${esc(number(reason.count))}</b> <span class="meta">${Math.round(share)}%</span></span>
			${showExample ? `<span class="meta clip failure-example">${esc(reason.last)}</span>` : ''}
		</li>`;
	}).join('')}</ul>`;
};

/** The panel of the overview: why URLs failed, over all crawlers. */
export const failuresPanel = (status: SupervisorStatus): string => {
	const failures = mergeFailures(status.crawlers.map(crawler => crawler.stats?.failures));
	const sum = failures.reduce((all, reason) => all + reason.count, 0);
	const body = failures.length === 0
		? `<div class="empty empty-ok">${icon('check')}<p>No errors since the crawlers started.</p></div>`
		: failureRows(failures, false);
	return `<div class="panel">
	<div class="panel-head"><h2>Errors ${sum ? `<span class="count count-bad">${esc(number(sum))}</span>` : ''}</h2><span class="meta">why URLs failed since start, hover a row for the latest example</span></div>
	${body}
</div>`;
};

/** The block of the crawler detail. Empty when the crawler has not reported errors. */
export const crawlerFailures = (failures: readonly Failure[]): string =>
	failures.length === 0 ? '' : `<div class="panel panel-inner"><h3>Errors since start</h3>${failureRows(failures, true)}</div>`;
