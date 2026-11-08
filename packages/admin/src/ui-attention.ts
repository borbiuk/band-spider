import { warningName } from './crawler-metrics';
import { SupervisorStatus } from './supervisor';
import { BAD_429_PER_HOUR, durationText, formatNumber, isFailing } from './ui-parts';

/** One line of the "Needs attention" list of the overview. */
export interface AttentionItem {
	tone: 'bad' | 'warn' | 'info';
	title: string;
	detail: string;
	/** The crawler the line is about. The page opens its details on a click. */
	crawler?: string;
}

/** A running crawler reports every minute. No report for this long means it hangs. */
export const STALL_MS = 3 * 60_000;

const ORDER = { bad: 0, warn: 1, info: 2 };

/**
 * What needs a look: failed processes, and crawlers that hang, get too many HTTP 429 answers or wait.
 * The worst come first.
 */
export const attentionItems = (status: SupervisorStatus, now: number): AttentionItem[] => {
	const items: AttentionItem[] = [];
	const { db } = status;
	if (db.state === 'failed') {
		items.push({ tone: 'bad', title: 'DB service failed', detail: db.error ?? 'it stopped with an error' });
	}
	if (db.dbStatsError) {
		items.push({ tone: 'warn', title: 'DB statistics cannot be read', detail: db.dbStatsError });
	}
	for (const crawler of status.crawlers) {
		const { name, stats } = crawler;
		const add = (tone: AttentionItem['tone'], title: string, detail: string): void => {
			items.push({ tone, title: `${name}: ${title}`, detail, crawler: name });
		};
		if (crawler.state === 'failed') {
			add('bad', 'failed', crawler.error ?? 'it stopped with an error');
		}
		if (!crawler.configured && crawler.state !== 'stopped') {
			add('warn', 'removed from the config', 'it still runs, stop it');
		}
		if (stats?.warning) {
			add('bad', warningName(stats.warning), `${stats.warning.message}. The proxy may not work.`);
		}
		if (crawler.state !== 'running' || !stats) {
			continue;
		}
		if (stats.http429PerHour >= BAD_429_PER_HOUR) {
			add('bad', 'too many HTTP 429', `${formatNumber(stats.http429PerHour)} in the last hour, slow it down or change the proxy`);
		}
		if (isFailing(crawler)) {
			const top = stats.failures[0];
			add('bad', 'most URLs fail', `${Math.round((stats.failShare ?? 0) * 100)}% of the latest URLs failed${top ? `, mostly: ${top.last}` : ''}. The proxy may be blocked.`);
		}
		const silentMs = stats.reportedAt === undefined ? 0 : now - stats.reportedAt;
		if (silentMs > STALL_MS) {
			add('warn', 'no report', `the last report came ${durationText(silentMs)} ago`);
		} else if (stats.pauseMs > 0) {
			add('warn', 'paused after HTTP 429', `${durationText(stats.pauseMs)} left`);
		} else if (stats.idle) {
			add('info', 'waiting for URLs', 'the queue gives it nothing to do');
		} else if (stats.requestsPerMin === 0) {
			add('warn', 'no requests', 'it sent no request in the last minutes');
		}
	}
	return items.sort((a, b) => ORDER[a.tone] - ORDER[b.tone]);
};
