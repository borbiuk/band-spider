import { MAX_REQUEST_DELAY_MS, MIN_REQUEST_DELAY_MS } from '@band-spider/core';
import { z } from 'zod';

/** Same limit as the crawler config. */
const MAX_WORKERS = 64;

/** One proxy entry of the Webshare list. */
export const webshareEntrySchema = z.object({
	host: z.string().min(1),
	port: z.number().int().min(1).max(65535),
	username: z.string().min(1),
	password: z.string().min(1),
});

export type WebshareEntry = z.infer<typeof webshareEntrySchema>;

/** One proxy of the pool that is imported from a file. Same shape as a Webshare entry. */
export const poolEntrySchema = webshareEntrySchema;
export type PoolEntry = WebshareEntry;

/** The key of a pool entry: host:port. A crawler points to it. */
export const poolKeyOf = ({ host, port }: { host: string; port: number }): string => `${host}:${port}`;

/** How a crawler reaches Bandcamp: from the local IP, through a proxy URL, or through a Webshare entry. */
export const proxySettingSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('none') }),
	z.object({ kind: z.literal('url'), url: z.url() }),
	z.object({ kind: z.literal('webshare'), entry: webshareEntrySchema }),
	// one proxy of the Webshare list, found with the API key of the admin config
	z.object({
		kind: z.literal('webshare-list'),
		index: z.number().int().min(0).optional(),
		id: z.string().min(1).optional(),
	}).refine(ref => (ref.index === undefined) !== (ref.id === undefined), { message: 'give an index or an id, not both' }),
	// one proxy of the imported pool, found by its host:port
	z.object({ kind: z.literal('pool'), key: z.string().min(1) }),
]);
export type ProxySetting = z.infer<typeof proxySettingSchema>;

export const crawlerSettingSchema = z.object({
	name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/i, 'use letters, digits, - and _ (up to 32 characters)'),
	type: z.enum(['item', 'account']),
	reverse: z.boolean().default(false),
	workers: z.number().int().min(1).max(MAX_WORKERS).default(1),
	minDelayMs: z.number().int().min(0).optional(),
	maxDelayMs: z.number().int().min(0).optional(),
	/** How long a crawler waits before it asks for URLs again when there are none. The crawler default is used when not set. */
	idleMs: z.number().int().min(0).optional(),
	proxy: proxySettingSchema.default({ kind: 'none' }),
}).refine(
	crawler => crawler.minDelayMs === undefined || crawler.maxDelayMs === undefined || crawler.minDelayMs <= crawler.maxDelayMs,
	{ message: 'minDelayMs must not be more than maxDelayMs', path: ['minDelayMs'] },
);
export type CrawlerSetting = z.infer<typeof crawlerSettingSchema>;

/** The schema defaults of a crawler. A saved config keeps only what differs from them. */
export const DEFAULT_WORKERS = 1;
export const DEFAULT_REVERSE = false;

/** The crawler without the values that equal the defaults. Missing values mean the defaults when the config is read again. */
export const compactCrawler = (crawler: CrawlerSetting): Partial<CrawlerSetting> & Pick<CrawlerSetting, 'name' | 'type' | 'proxy'> => {
	const { reverse, workers, minDelayMs, maxDelayMs, ...rest } = crawler;
	return {
		...rest,
		...(reverse !== DEFAULT_REVERSE && { reverse }),
		...(workers !== DEFAULT_WORKERS && { workers }),
		...(minDelayMs !== undefined && minDelayMs !== MIN_REQUEST_DELAY_MS && { minDelayMs }),
		...(maxDelayMs !== undefined && maxDelayMs !== MAX_REQUEST_DELAY_MS && { maxDelayMs }),
	};
};

export const dbServiceSettingSchema = z.object({
	/** 0 means a random free port. The crawlers get the real URL from the ready message. */
	port: z.number().int().min(0).max(65535).default(4100),
	token: z.string().min(1).optional(),
	leaseMs: z.number().int().min(1).optional(),
	/** The SQLite file. The service default is used when not set. */
	dbFile: z.string().min(1).optional(),
});
export type DbServiceSetting = z.infer<typeof dbServiceSettingSchema>;

/** The account that gives the proxy lists. */
export const webshareAccountSchema = z.object({
	apiKey: z.string().min(1),
});
export type WebshareAccount = z.infer<typeof webshareAccountSchema>;

export const adminConfigSchema = z.object({
	webshare: webshareAccountSchema.optional(),
	/** The proxies that were imported from a file. */
	proxyPool: z.array(poolEntrySchema).default([]),
	dbService: dbServiceSettingSchema.default({ port: 4100 }),
	crawlers: z.array(crawlerSettingSchema).default([]),
}).refine(
	config => new Set(config.crawlers.map(crawler => crawler.name.toLowerCase())).size === config.crawlers.length,
	{ message: 'crawler names must be unique', path: ['crawlers'] },
).refine(
	config => new Set(config.proxyPool.map(poolKeyOf)).size === config.proxyPool.length,
	{ message: 'proxy pool entries must be unique by host:port', path: ['proxyPool'] },
);
export type AdminConfig = z.infer<typeof adminConfigSchema>;

/** The config as it is written to disk: every crawler is compact. */
export const compactConfig = (config: AdminConfig): Omit<AdminConfig, 'crawlers'> & { crawlers: ReturnType<typeof compactCrawler>[] } =>
	({ ...config, crawlers: config.crawlers.map(compactCrawler) });

export const defaultAdminConfig = (): AdminConfig => adminConfigSchema.parse({});

/** The proxy URL of one proxy with a user name and a password. */
export const proxyUrlOfEntry = ({ host, port, username, password }: WebshareEntry): string =>
	`http://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}`;

/** The proxy URL a crawler gets, or undefined for the local IP. A webshare-list or pool setting must be resolved first. */
export const proxyUrlOf = (proxy: ProxySetting): string | undefined => {
	switch (proxy.kind) {
		case 'webshare-list':
			throw new Error('A Webshare list proxy must be resolved with the list first');
		case 'pool':
			throw new Error('A pool proxy must be resolved with the pool first');
		case 'none':
			return undefined;
		case 'url':
			return proxy.url;
		case 'webshare':
			return proxyUrlOfEntry(proxy.entry);
	}
};
