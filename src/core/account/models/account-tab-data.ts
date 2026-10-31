export interface AccountTabData {
	total: number,
	urls: string[],
	/** The tab was read to its end, or to the batch with the mark of its last complete read. */
	complete: boolean,
	/** The read stopped at the mark of the last complete read: the older records are saved already. */
	stoppedAtMark?: boolean,
	error?: Error
}

export const defaultAccountTabData: AccountTabData = { total: 0, urls: [], complete: true };
export const errorAccountTabData = (error: Error): AccountTabData => ({ total: 0, urls: [], complete: false, error });
