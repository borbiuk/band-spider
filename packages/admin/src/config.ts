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
	dbService: dbServiceSettingSchema.default({ port: 4100 }),
	crawlers: z.array(crawlerSettingSchema).default([]),
}).refine(
	config => new Set(config.crawlers.map(crawler => crawler.name.toLowerCase())).size === config.crawlers.length,
	{ message: 'crawler names must be unique', path: ['crawlers'] },
);
export type AdminConfig = z.infer<typeof adminConfigSchema>;

export const defaultAdminConfig = (): AdminConfig => adminConfigSchema.parse({});

/** The proxy URL of one proxy with a user name and a password. */
export const proxyUrlOfEntry = ({ host, port, username, password }: WebshareEntry): string =>
	`http://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}`;

/** The proxy URL a crawler gets, or undefined for the local IP. A webshare-list setting must be resolved first. */
export const proxyUrlOf = (proxy: ProxySetting): string | undefined => {
	switch (proxy.kind) {
		case 'webshare-list':
			throw new Error('A Webshare list proxy must be resolved with the list first');
		case 'none':
			return undefined;
		case 'url':
			return proxy.url;
		case 'webshare':
			return proxyUrlOfEntry(proxy.entry);
	}
};
