import { AdminError } from './errors';

/** One proxy of a provider list. */
export interface ProxyEntry {
	id: string;
	host: string;
	port: number;
	username: string;
	password: string;
	/** Only the proxies that the provider calls valid are listed. */
	valid: boolean;
	countryCode?: string;
}

/** Where the admin gets a list of proxies from. Webshare is one implementation. */
export interface ProxyListSource {
	list(): Promise<ProxyEntry[]>;
}

export interface WebshareOptions {
	apiKey: string;
	/** Used by tests. The real API is the default. */
	baseUrl?: string;
	fetchFn?: typeof fetch;
	/** "direct" for datacenter lists, "backbone" for residential ones. */
	mode?: 'direct' | 'backbone';
	pageSize?: number;
	/** A guard against a list that never ends. */
	maxPages?: number;
}

export const WEBSHARE_API = 'https://proxy.webshare.io';

/** Official docs: https://apidocs.webshare.io/proxy-list/list */
const LIST_PATH = '/api/v2/proxy/list/';
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 50;

/** Loads the proxy list from the Webshare API. The API key is only sent to the base URL, and never logged. */
export class WebshareProxySource implements ProxyListSource {
	private readonly baseUrl: string;
	private readonly fetchFn: typeof fetch;

	constructor(private readonly options: WebshareOptions) {
		this.baseUrl = options.baseUrl ?? WEBSHARE_API;
		this.fetchFn = options.fetchFn ?? ((input, init) => globalThis.fetch(input, init));
	}

	async list(): Promise<ProxyEntry[]> {
		const origin = new URL(this.baseUrl).origin;
		const first = new URL(LIST_PATH, origin);
		first.searchParams.set('mode', this.options.mode ?? 'direct');
		first.searchParams.set('page', '1');
		first.searchParams.set('page_size', String(this.options.pageSize ?? DEFAULT_PAGE_SIZE));

		const entries: ProxyEntry[] = [];
		let next: string | null = first.toString();
		for (let page = 0; next !== null; page++) {
			if (page >= (this.options.maxPages ?? DEFAULT_MAX_PAGES)) {
				throw new AdminError('The Webshare list has too many pages', 502);
			}
			// the key must not leave for another host, even if the API sends a strange next link
			if (new URL(next).origin !== origin) {
				throw new AdminError('The Webshare API sent a next link to another host', 502);
			}
			const body = await this.getPage(next);
			for (const item of body.results) {
				entries.push(toEntry(item));
			}
			next = body.next ?? null;
		}
		return entries.filter(entry => entry.valid);
	}

	private async getPage(url: string): Promise<{ results: unknown[]; next?: string | null }> {
		let response: Response;
		try {
			const headers = { Authorization: `Token ${this.options.apiKey}` };
			response = await this.fetchFn(url, { headers });
		} catch {
			throw new AdminError('The Webshare API is not reachable', 502);
		}
		if (response.status === 401 || response.status === 403) {
			throw new AdminError('The Webshare API refused the API key', 502);
		}
		if (!response.ok) {
			throw new AdminError(`The Webshare API answered HTTP ${response.status}`, 502);
		}
		const body = await response.json().catch((): undefined => undefined) as { results?: unknown; next?: unknown } | undefined;
		if (!body || !Array.isArray(body.results) || (body.next != null && typeof body.next !== 'string')) {
			throw new AdminError('The Webshare API answer has an unknown shape', 502);
		}
		return { results: body.results, next: body.next as string | null | undefined };
	}
}

const toEntry = (item: unknown): ProxyEntry => {
	const row = item as Record<string, unknown>;
	if (
		typeof row?.id !== 'string' || typeof row.proxy_address !== 'string' || typeof row.port !== 'number'
		|| typeof row.username !== 'string' || typeof row.password !== 'string'
	) {
		throw new AdminError('The Webshare API answer has an unknown shape', 502);
	}
	return {
		id: row.id,
		host: row.proxy_address,
		port: row.port,
		username: row.username,
		password: row.password,
		valid: row.valid !== false,
		...(typeof row.country_code === 'string' ? { countryCode: row.country_code } : {}),
	};
};

/** Picks one proxy by id or by its place in the list. */
export const pickProxy = (entries: ProxyEntry[], ref: { index?: number; id?: string }): ProxyEntry => {
	const entry = ref.id !== undefined ? entries.find(item => item.id === ref.id) : entries[ref.index ?? -1];
	if (!entry) {
		const what = ref.id !== undefined ? `id ${ref.id}` : `index ${ref.index}`;
		throw new AdminError(`No Webshare proxy with ${what} (the list has ${entries.length})`, 502);
	}
	return entry;
};
