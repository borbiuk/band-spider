import { StatsResponse, statsResponseSchema } from '@band-spider/contracts';

/** What the admin shows about the DB service. */
export type DbStats = StatsResponse;

/** Reads the counters of a running DB service. */
export interface DbStatsSource {
	read(url: string, token?: string): Promise<DbStats>;
}

/** Reads GET /stats of the DB service over HTTP. */
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
}
