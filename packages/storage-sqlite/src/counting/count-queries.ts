import { ItemType } from '../models/item-url';
import { MAX_FAILED, REPROCESS_BEFORE_SECONDS } from '../repositories/selection';

/** The part of a better-sqlite3 connection that the counts use. */
export interface CountConnection {
	prepare(sql: string): { pluck(): { get(...parameters: unknown[]): unknown }, all(...parameters: unknown[]): unknown[] };
}

/** The size of the DB, without the time it was counted. */
export interface RowCounts {
	items: number;
	itemsProcessed: number;
	accounts: number;
	accountsProcessed: number;
	itemAccountRelations: number;
	wishlistRelations: number;
	followers: number;
}

const count = (connection: CountConnection, sql: string, ...parameters: unknown[]): number =>
	Number(connection.prepare(sql).pluck().get(...parameters));

const NOT_PROCESSED = '(lastProcessingDate IS NULL OR lastProcessingDate < ?) AND failedCount < ? AND isBusy = 0';

/**
 * How many items and accounts wait to be claimed. It is the SQL of `countNotProcessed` of the two
 * repositories (the same filter as `notProcessedWhere`, and only tracks).
 */
export const countQueueLeft = (connection: CountConnection): { items: number, accounts: number } => ({
	items: count(connection, `SELECT COUNT(*) FROM items WHERE ${NOT_PROCESSED} AND type = ${ItemType.Track}`, REPROCESS_BEFORE_SECONDS, MAX_FAILED),
	accounts: count(connection, `SELECT COUNT(*) FROM accounts WHERE ${NOT_PROCESSED}`, REPROCESS_BEFORE_SECONDS, MAX_FAILED),
});

/** The size of every table that the admin shows. */
export const countRows = (connection: CountConnection): RowCounts => ({
	items: count(connection, 'SELECT COUNT(*) FROM items'),
	itemsProcessed: count(connection, 'SELECT COUNT(*) FROM items WHERE lastProcessingDate >= ?', REPROCESS_BEFORE_SECONDS),
	accounts: count(connection, 'SELECT COUNT(*) FROM accounts'),
	accountsProcessed: count(connection, 'SELECT COUNT(*) FROM accounts WHERE lastProcessingDate >= ?', REPROCESS_BEFORE_SECONDS),
	itemAccountRelations: count(connection, 'SELECT COUNT(*) FROM items_to_accounts'),
	wishlistRelations: count(connection, 'SELECT COUNT(*) FROM items_to_accounts WHERE wishlist = 1'),
	followers: count(connection, 'SELECT COUNT(*) FROM followers'),
});

/** How many rows of one table were processed last in each month, and how many rows the table has. */
export interface MonthlyProcessing {
	total: number;
	/** Months with at least one row, oldest first. `month` is `YYYY-MM` in UTC. */
	months: Array<{ month: string, count: number }>;
}

/** When the items and the accounts were processed, without the time it was counted. */
export interface ProcessingHistoryCounts {
	items: MonthlyProcessing;
	accounts: MonthlyProcessing;
}

/**
 * One pass over the table, grouped by the month of `lastProcessingDate`. The group without a month is
 * the rows that were never processed: it is part of the total, and it is not a month.
 */
export const processingMonthsSql = (table: 'items' | 'accounts'): string =>
	`SELECT strftime('%Y-%m', lastProcessingDate, 'unixepoch') AS month, COUNT(*) AS count FROM ${table} GROUP BY month ORDER BY month`;

/** Turns the rows of `processingMonthsSql` into the total and the months. */
export const toMonthlyProcessing = (rows: Array<{ month: unknown, count: unknown }>): MonthlyProcessing => ({
	total: rows.reduce((sum, row) => sum + Number(row.count), 0),
	months: rows.filter(row => row.month !== null).map(row => ({ month: String(row.month), count: Number(row.count) })),
});

/** The months in which the items and the accounts were processed. It scans both tables, so it runs off the main thread. */
export const countProcessingHistory = (connection: CountConnection): ProcessingHistoryCounts => ({
	items: toMonthlyProcessing(connection.prepare(processingMonthsSql('items')).all() as Array<{ month: unknown, count: unknown }>),
	accounts: toMonthlyProcessing(connection.prepare(processingMonthsSql('accounts')).all() as Array<{ month: unknown, count: unknown }>),
});
