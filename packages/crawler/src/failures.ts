import { FailureReport } from '@band-spider/core';

/** How often one reason came up and the latest example. */
export interface FailureCount {
	count: number;
	/** The message of the latest error, with its URL. */
	last: string;
}

/** The most reasons that are kept. Reasons beyond this are counted together as `other`. */
export const MAX_FAILURE_KEYS = 30;
const MAX_MESSAGE_LENGTH = 300;

/** Counts the failures of a crawler by their reason. */
export class FailureTally {
	private readonly counts = new Map<string, FailureCount>();

	record({ key, message, url }: FailureReport): void {
		const reason = this.counts.has(key) || this.counts.size < MAX_FAILURE_KEYS ? key : 'other';
		const entry = this.counts.get(reason) ?? { count: 0, last: '' };
		entry.count++;
		entry.last = `${message} (${url})`.slice(0, MAX_MESSAGE_LENGTH);
		this.counts.set(reason, entry);
	}

	/** A copy of the counts by reason. */
	snapshot(): Record<string, FailureCount> {
		return Object.fromEntries([...this.counts].map(([key, entry]) => [key, { ...entry }]));
	}
}
