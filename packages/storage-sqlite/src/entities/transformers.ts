import { ValueTransformer } from 'typeorm';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** A `Date` written as a number. A number is written as it is, so queries can compare with a ready value. */
const toNumber = (convert: (date: Date) => number) => (value: Date | number | null | undefined): number | null | undefined =>
	value instanceof Date ? convert(value) : value;

/** A moment in time as unix seconds. */
export const toUnixSeconds = (date: Date): number => Math.floor(date.getTime() / 1000);

/**
 * A calendar day as the number of days since 1970-01-01. The day is the one of the local time of the
 * `Date`, as the old `date` columns stored it.
 */
export const toEpochDays = (date: Date): number =>
	Math.round(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / MS_PER_DAY);

/** For `integer` columns that hold unix seconds. */
export const unixSecondsTransformer: ValueTransformer = {
	to: toNumber(toUnixSeconds),
	from: (value: number | null) => value === null || value === undefined ? value : new Date(value * 1000),
};

/** For `integer` columns that hold a day as days since 1970-01-01. It reads back as UTC midnight of that day. */
export const epochDaysTransformer: ValueTransformer = {
	to: toNumber(toEpochDays),
	from: (value: number | null) => value === null || value === undefined ? value : new Date(value * MS_PER_DAY),
};
