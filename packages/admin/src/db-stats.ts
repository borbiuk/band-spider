import { StatsResponse, statsResponseSchema, TotalsResponse, totalsResponseSchema } from '@band-spider/contracts';

/** What the admin shows about the DB service. */
export type DbStats = StatsResponse;

/** The size of the DB. */
export type DbTotals = TotalsResponse;

/** Reads the counters of a running DB service. */
export interface DbStatsSource {
	read(url: string, token?: string): Promise<DbStats>;
	/** Reads the size of the DB. Counting a big DB takes seconds, so ask rarely. A source without it has no totals. */
	readTotals?(url: string, token?: string): Promise<DbTotals>;
}

const TOTALS_TIMEOUT_MS = 120_000;

/** Reads GET /stats and GET /totals of the DB service over HTTP. */
export class HttpDbStatsSource implements DbStatsSource {
	constructor(private readonly timeoutMs = 3000) {
	}

	async read(url: string, token?: string): Promise<DbStats> {
		const response = await fetch(new URL('/stats', url), {
			headers: token ? { authorization: `Bearer ${token}` } : {},
			signal: AbortSignal.timeout(this.timeoutMs),
		});
		if (!response.ok) {
			throw new Error(`DB service answered HTTP ${response.status}`);
		}
		return statsResponseSchema.parse(await response.json());
	}

	async readTotals(url: string, token?: string): Promise<DbTotals> {
		// counting every table of a big DB can take a while
		const response = await fetch(new URL('/totals', url), {
			headers: token ? { authorization: `Bearer ${token}` } : {},
			signal: AbortSignal.timeout(TOTALS_TIMEOUT_MS),
		});
		if (!response.ok) {
			throw new Error(`DB service answered HTTP ${response.status} for the DB size`);
		}
		return totalsResponseSchema.parse(await response.json());
	}
}
