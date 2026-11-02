/** What a bulk action of the crawler table does. */
export type BulkAction = 'start' | 'stop' | 'restart' | 'remove';

const PAST: Record<BulkAction, string> = { start: 'started', stop: 'stopped', restart: 'restarted', remove: 'removed' };

/** Why a chosen crawler was skipped. */
const SKIP_REASON: Record<BulkAction, string> = {
	start: 'already running',
	stop: 'not running',
	restart: 'not in the config',
	remove: 'still running or not in the config',
};

const crawlers = (count: number): string => `${count} ${count === 1 ? 'crawler' : 'crawlers'}`;

/** The message after a bulk action: what was done, what was skipped and the first errors. */
export const bulkText = (action: BulkAction, done: number, skipped: number, failed: string[]): string => {
	const parts = [`${crawlers(done)} ${PAST[action]}`];
	if (skipped > 0) {
		parts.push(`${skipped} skipped (${SKIP_REASON[action]})`);
	}
	if (failed.length > 0) {
		parts.push(`${failed.length} failed: ${failed.slice(0, 3).join('; ')}`);
	}
	return parts.join(', ');
};
