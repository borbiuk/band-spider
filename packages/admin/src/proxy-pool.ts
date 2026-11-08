import { AdminConfig, PoolEntry, poolKeyOf } from './config';
import { ConfigStore } from './config-store';
import { conflict, notFound } from './errors';
import { ProxyListSource, WebshareProxySource } from './webshare';
import { parseProxyList, ProxyListError } from './proxy-list';

export type ImportMode = 'append' | 'replace';

/** What an import did. It has no password. */
export interface ImportResult {
	added: number;
	updated: number;
	/** Bad lines and lines with a host:port that came earlier in the same list. */
	skipped: number;
	/** The bad lines. */
	errors: ProxyListError[];
	/** The duplicate lines. */
	duplicateLines: number[];
}

/** One pool entry for the API and the page. It has no password. */
export interface PoolItem {
	key: string;
	host: string;
	port: number;
	username: string;
	/** Two letters, like US. Missing until the countries are detected. */
	countryCode?: string;
	/** Names of the crawlers that use this entry. */
	usedBy: string[];
}

/** For each pool key: the crawlers that use it. */
export const poolUsage = (config: AdminConfig): Map<string, string[]> => {
	const usage = new Map<string, string[]>();
	for (const crawler of config.crawlers) {
		if (crawler.proxy.kind === 'pool') {
			usage.set(crawler.proxy.key, [...(usage.get(crawler.proxy.key) ?? []), crawler.name]);
		}
	}
	return usage;
};

const usedText = (key: string, crawlers: string[]): string => `${key} (used by ${crawlers.join(', ')})`;

/** The pool after an import. Append keeps the old order and updates entries in place, replace uses the list. */
export const mergePool = (pool: PoolEntry[], entries: PoolEntry[], mode: ImportMode): { pool: PoolEntry[]; added: number; updated: number } => {
	const old = new Set(pool.map(poolKeyOf));
	const updated = entries.filter(entry => old.has(poolKeyOf(entry))).length;
	const added = entries.length - updated;
	if (mode === 'replace') {
		return { pool: entries, added, updated };
	}
	const incoming = new Map(entries.map(entry => [poolKeyOf(entry), entry]));
	// an import file has no country, so an updated entry keeps the one it had
	const merged = pool.map(entry => {
		const next = incoming.get(poolKeyOf(entry));
		const countryCode = next?.countryCode ?? entry.countryCode;
		return next ? { ...next, ...(countryCode ? { countryCode } : {}) } : entry;
	});
	return { pool: [...merged, ...entries.filter(entry => !old.has(poolKeyOf(entry)))], added, updated };
};

/** Imports, lists and deletes the proxy pool of the admin config. It only knows the ConfigStore. */
export class ProxyPoolService {
	constructor(
		private readonly configStore: ConfigStore,
		/** Makes the proxy list source for an API key. The Webshare API is the default. */
		private readonly listFactory: (apiKey: string) => ProxyListSource = apiKey => new WebshareProxySource({ apiKey }),
		/** WEBSHARE_API_KEY is read from here when the admin config has no key. The admin loads the .env file at start. */
		private readonly env: NodeJS.ProcessEnv = process.env,
	) {
	}

	async list(): Promise<PoolItem[]> {
		return this.itemsOf(await this.configStore.load());
	}

	itemsOf(config: AdminConfig): PoolItem[] {
		const usage = poolUsage(config);
		return config.proxyPool.map(entry => ({
			key: poolKeyOf(entry),
			host: entry.host,
			port: entry.port,
			username: entry.username,
			...(entry.countryCode ? { countryCode: entry.countryCode } : {}),
			usedBy: usage.get(poolKeyOf(entry)) ?? [],
		}));
	}

	/** Reads a list and saves the pool. Bad lines are skipped and reported. Replace never drops an entry that a crawler uses. */
	async importList(text: string, mode: ImportMode): Promise<ImportResult> {
		const parsed = parseProxyList(text);
		const config = await this.configStore.load();
		const merged = mergePool(config.proxyPool, parsed.entries, mode);
		if (mode === 'replace') {
			if (parsed.entries.length === 0) {
				throw conflict('The list has no valid proxy, so the pool was not replaced');
			}
			const keep = new Set(merged.pool.map(poolKeyOf));
			const dropped = [...poolUsage(config)].filter(([key]) => !keep.has(key));
			if (dropped.length > 0) {
				throw conflict(`Replace would remove proxies that crawlers use: ${dropped.map(([key, names]) => usedText(key, names)).join('; ')}`);
			}
		}
		await this.configStore.save({ ...config, proxyPool: merged.pool });
		return {
			added: merged.added,
			updated: merged.updated,
			skipped: parsed.errors.length + parsed.duplicateLines.length,
			errors: parsed.errors,
			duplicateLines: parsed.duplicateLines,
		};
	}

	/**
	 * Asks the Webshare API for the proxy list and saves the country of each pool entry that is in it (matched by host:port).
	 * The API key only goes to Webshare. Entries that the list does not have keep what they had.
	 */
	async detectCountries(): Promise<CountryResult> {
		const config = await this.configStore.load();
		const apiKey = config.webshare?.apiKey || this.env.WEBSHARE_API_KEY?.trim();
		if (!apiKey) {
			throw conflict('No Webshare API key. Put WEBSHARE_API_KEY=... in the .env file and restart the admin.');
		}
		const listed = await this.listFactory(apiKey).list();
		const countries = new Map<string, string>();
		for (const entry of listed) {
			if (entry.countryCode) {
				countries.set(`${entry.host.toLowerCase()}:${entry.port}`, entry.countryCode.toUpperCase());
			}
		}
		let matched = 0;
		const proxyPool = config.proxyPool.map(entry => {
			const countryCode = countries.get(poolKeyOf(entry));
			if (countryCode === undefined) {
				return entry;
			}
			matched++;
			return { ...entry, countryCode };
		});
		await this.configStore.save({ ...config, proxyPool });
		return { matched, unmatched: config.proxyPool.length - matched, total: config.proxyPool.length };
	}

	/** Deletes one entry. It is refused while a crawler uses it. */
	async remove(key: string): Promise<void> {
		const config = await this.configStore.load();
		if (!config.proxyPool.some(entry => poolKeyOf(entry) === key)) {
			throw notFound(`No proxy ${key} in the pool`);
		}
		const users = poolUsage(config).get(key);
		if (users) {
			throw conflict(`Proxy ${key} is used by ${users.join(', ')}. Change the proxy of the crawler first`);
		}
		await this.configStore.save({ ...config, proxyPool: config.proxyPool.filter(entry => poolKeyOf(entry) !== key) });
	}

	/**
	 * Deletes many entries at once: the given keys, or the whole pool when no keys are given.
	 * An entry that a crawler uses is kept and reported, like in `remove`. Keys not in the pool are ignored.
	 */
	async removeMany(keys?: string[]): Promise<RemoveManyResult> {
		const config = await this.configStore.load();
		const wanted = keys === undefined ? undefined : new Set(keys);
		const usage = poolUsage(config);
		const removed: string[] = [];
		const kept: { key: string; usedBy: string[] }[] = [];
		const pool = config.proxyPool.filter(entry => {
			const key = poolKeyOf(entry);
			if (wanted && !wanted.has(key)) {
				return true;
			}
			const users = usage.get(key);
			if (users) {
				kept.push({ key, usedBy: users });
				return true;
			}
			removed.push(key);
			return false;
		});
		if (removed.length > 0) {
			await this.configStore.save({ ...config, proxyPool: pool });
		}
		return { removed, kept };
	}
}

/** What "Detect countries" did. */
export interface CountryResult {
	matched: number;
	/** Pool entries that the Webshare list does not have. They have no country. */
	unmatched: number;
	total: number;
}

/** A short text about the detection, for a message on the page. */
export const countryResultText = ({ matched, unmatched, total }: CountryResult): string =>
	unmatched === 0 ? `Country found for all ${total} proxies` : `Country found for ${matched} of ${total} proxies. ${unmatched} are not in the Webshare list`;

/** What a delete of many entries did. */
export interface RemoveManyResult {
	removed: string[];
	/** Entries that were asked for but kept, because crawlers use them. */
	kept: { key: string; usedBy: string[] }[];
}

/** A short text about a delete of many entries, for a message on the page. */
export const removeManyText = ({ removed, kept }: RemoveManyResult): string => {
	const parts = [`${removed.length} ${removed.length === 1 ? 'proxy' : 'proxies'} deleted`];
	if (kept.length > 0) {
		const crawlers = [...new Set(kept.flatMap(item => item.usedBy))];
		const names = crawlers.slice(0, 5).join(', ') + (crawlers.length > 5 ? ` and ${crawlers.length - 5} more` : '');
		parts.push(`${kept.length} kept, because crawlers use them (${names}). Remove those crawlers or change their proxy first`);
	}
	return parts.join('. ');
};
