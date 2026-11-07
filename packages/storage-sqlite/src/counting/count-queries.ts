import { ItemType } from '../models/item-url';
import { MAX_FAILED, REPROCESS_BEFORE_SECONDS } from '../repositories/selection';

/** The part of a better-sqlite3 connection that the counts use. */
export interface CountConnection {
	prepare(sql: string): { pluck(): { get(...parameters: unknown[]): unknown } };
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
