import { IsNull, LessThan, MoreThanOrEqual, Or } from 'typeorm';
import { toUnixSeconds } from '../entities/transformers';

/** An item or an account processed before this date is processed again. */
export const REPROCESS_BEFORE = new Date('2026-01-01');

/** `REPROCESS_BEFORE` as stored in `lastProcessingDate`, for raw SQL. TypeORM converts the `Date` itself. */
export const REPROCESS_BEFORE_SECONDS = toUnixSeconds(REPROCESS_BEFORE);

/** A URL that failed this many times is not claimed again. */
export const MAX_FAILED = 3;

/**
 * `failedCount` of a page that does not exist on Bandcamp (HTTP 404). It is a mark, not a count:
 * it is far above `MAX_FAILED`, so such a URL is never claimed again, and a new failure keeps it.
 */
export const NOT_FOUND_MARK = 404;

/** The rows that are claimed, for items and accounts alike. */
export const notProcessedWhere = () => ({
	lastProcessingDate: Or(IsNull(), LessThan(REPROCESS_BEFORE)),
	failedCount: LessThan(MAX_FAILED),
	isBusy: false,
});

/** The rows that were processed since `REPROCESS_BEFORE`. */
export const processedWhere = () => ({ lastProcessingDate: MoreThanOrEqual(REPROCESS_BEFORE) });

/** SQL for `failedCount` after one more failure. A not-found mark stays as it is. */
export const NEXT_FAILED_COUNT_SQL = `CASE WHEN failedCount = ${NOT_FOUND_MARK} THEN ${NOT_FOUND_MARK} ELSE COALESCE(failedCount, 0) + 1 END`;
