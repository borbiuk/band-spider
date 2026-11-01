export interface AccountTabStatistic {
	total: number,
	allScraped: boolean,
	newRecords: number,
	newRelations: number,
	/** URLs that did not exist in the database before this page was saved. */
	newUrls: string[],
}
