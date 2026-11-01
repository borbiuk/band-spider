import { AdminConfig, PoolEntry, poolKeyOf } from './config';
import { ConfigStore } from './config-store';
import { conflict, notFound } from './errors';
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
	const merged = pool.map(entry => incoming.get(poolKeyOf(entry)) ?? entry);
	return { pool: [...merged, ...entries.filter(entry => !old.has(poolKeyOf(entry)))], added, updated };
};

/** Imports, lists and deletes the proxy pool of the admin config. It only knows the ConfigStore. */
export class ProxyPoolService {
	constructor(private readonly configStore: ConfigStore) {
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
}
