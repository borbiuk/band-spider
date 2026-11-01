import { z } from 'zod';
import { AdminConfig, CrawlerSetting, crawlerSettingSchema, poolKeyOf } from './config';
import { ConfigStore } from './config-store';
import { poolUsage } from './proxy-pool';

/** What type the new crawlers get. Split alternates item and account, items first. */
export const autoCrawlerKindSchema = z.enum(['item', 'account', 'split']);
export type AutoCrawlerKind = z.infer<typeof autoCrawlerKindSchema>;

/** What an add did. The names are in the order of the pool. */
export interface AutoAddResult {
	added: number;
	names: string[];
}

const NAME_PREFIX = { item: 'items', account: 'accounts' } as const;

/** Pool keys that no crawler uses, in the order of the pool. */
export const freePoolKeys = (config: AdminConfig): string[] => {
	const usage = poolUsage(config);
	return config.proxyPool.map(poolKeyOf).filter(key => !usage.has(key));
};

/** The type of the n-th new crawler (from 0). */
const typeOf = (kind: AutoCrawlerKind, index: number): CrawlerSetting['type'] =>
	kind === 'split' ? (index % 2 === 0 ? 'item' : 'account') : kind;

/** Hands out names like items-1, items-2. A taken name (also in another letter case) is skipped. */
const nameGenerator = (config: AdminConfig): (type: CrawlerSetting['type']) => string => {
	const taken = new Set(config.crawlers.map(crawler => crawler.name.toLowerCase()));
	const next = { item: 1, account: 1 };
	return type => {
		let name: string;
		do {
			name = `${NAME_PREFIX[type]}-${next[type]++}`;
		} while (taken.has(name));
		taken.add(name);
		return name;
	};
};

/** One new crawler for each free proxy. Only the name, the type and the proxy are set, the rest stays at the defaults. */
export const planAutoCrawlers = (config: AdminConfig, kind: AutoCrawlerKind): CrawlerSetting[] => {
	const nameOf = nameGenerator(config);
	return freePoolKeys(config).map((key, index) => {
		const type = typeOf(kind, index);
		return crawlerSettingSchema.parse({ name: nameOf(type), type, proxy: { kind: 'pool', key } });
	});
};

/** Adds one crawler for each free pool proxy. It only knows the ConfigStore. The crawlers are not started. */
export class AutoCrawlerService {
	constructor(private readonly configStore: ConfigStore) {
	}

	async addForFreeProxies(kind: AutoCrawlerKind): Promise<AutoAddResult> {
		const config = await this.configStore.load();
		const created = planAutoCrawlers(config, kind);
		if (created.length > 0) {
			await this.configStore.save({ ...config, crawlers: [...config.crawlers, ...created] });
		}
		return { added: created.length, names: created.map(crawler => crawler.name) };
	}
}

/** The line after an add, for the page. */
export const autoAddText = (result: AutoAddResult): string =>
	result.added === 0
		? 'No free proxy: every proxy of the pool is used by a crawler'
		: `${result.added} ${result.added === 1 ? 'crawler' : 'crawlers'} added: ${result.names.join(', ')}`;
