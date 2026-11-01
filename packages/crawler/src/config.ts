import { z } from 'zod';

export const MAX_WORKERS = 64;
export const DEFAULT_IDLE_MS = 30_000;

/** The settings of one crawler process. */
export const crawlerConfigSchema = z.object({
	/** The DB service. The crawler reaches it directly, never through the proxy. */
	dbUrl: z.url(),
	token: z.string().min(1).optional(),
	type: z.enum(['item', 'account']),
	reverse: z.boolean().default(false),
	workers: z.number().int().min(1).max(MAX_WORKERS).default(1),
	/** The random pause from the end of one request to the start of the next one. The HTTP client defaults are used when not set. */
	minDelayMs: z.number().int().min(0).optional(),
	maxDelayMs: z.number().int().min(0).optional(),
	/** How long a worker waits before it asks for URLs again when there are none. Default 30000. 0 means the crawler exits when no URL is left. */
	idleMs: z.number().int().min(0).optional(),
	/** A proxy URL for the page requests. Without it the local IP is used. */
	proxy: z.url().optional(),
}).refine(
	config => config.minDelayMs === undefined || config.maxDelayMs === undefined || config.minDelayMs <= config.maxDelayMs,
	{ message: 'minDelayMs must not be more than maxDelayMs', path: ['minDelayMs'] },
);

export type CrawlerConfig = z.infer<typeof crawlerConfigSchema>;

/** A config that is not complete yet: env gives some keys, an IPC message gives the others. */
export type PartialCrawlerConfig = Record<string, unknown>;

const numberOf = (value: string | undefined): number | undefined =>
	value === undefined || value === '' ? undefined : Number(value);

/**
 * Reads what the environment and the arguments say: CRAWLER_DB_URL, CRAWLER_DB_TOKEN, CRAWLER_TYPE,
 * CRAWLER_REVERSE, CRAWLER_WORKERS, CRAWLER_MIN_DELAY_MS, CRAWLER_MAX_DELAY_MS, CRAWLER_IDLE_MS and CRAWLER_PROXY.
 * `--account` and `--reverse` win over CRAWLER_TYPE and CRAWLER_REVERSE.
 */
export const readEnvConfig = (env: NodeJS.ProcessEnv = process.env, args: string[] = []): PartialCrawlerConfig => {
	const config: PartialCrawlerConfig = {
		dbUrl: env.CRAWLER_DB_URL || undefined,
		token: env.CRAWLER_DB_TOKEN || undefined,
		type: args.includes('--account') ? 'account' : (env.CRAWLER_TYPE || undefined),
		reverse: args.includes('--reverse') || env.CRAWLER_REVERSE === 'true' || undefined,
		workers: numberOf(env.CRAWLER_WORKERS),
		minDelayMs: numberOf(env.CRAWLER_MIN_DELAY_MS),
		maxDelayMs: numberOf(env.CRAWLER_MAX_DELAY_MS),
		idleMs: numberOf(env.CRAWLER_IDLE_MS),
		proxy: env.CRAWLER_PROXY || undefined,
	};
	// a key without a value is not a setting
	return Object.fromEntries(Object.entries(config).filter(([, value]) => value !== undefined));
};

/** Checks the settings. A later source wins over an earlier one, key by key. */
export const parseCrawlerConfig = (...sources: PartialCrawlerConfig[]): CrawlerConfig => {
	const result = crawlerConfigSchema.safeParse(Object.assign({}, ...sources));
	if (!result.success) {
		// the issues name the keys, not the values, so a proxy password stays out of the log
		const issues = result.error.issues.map(issue => `${issue.path.join('.') || 'config'}: ${issue.message}`);
		throw new Error(`Crawler config is invalid: ${issues.join('; ')}`);
	}
	return result.data;
};

/** Messages a parent sends to a crawler that was started with fork. */
export const parentMessageSchema = z.discriminatedUnion('type', [
	z.object({ type: z.literal('config'), config: z.record(z.string(), z.unknown()) }),
	z.object({ type: z.literal('stop') }),
]);
export type ParentMessage = z.infer<typeof parentMessageSchema>;
