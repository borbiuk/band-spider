import { ApiRefusedError } from '../../../common/errors';
import { RateLimitedError } from '../../../common/rate-limit-gate';
import { isAccountUrl, isItemUrl, isNullOrUndefined, originalUrl } from '../../../common/utils';
import { AccountTab } from '../../../models/account-tab';
import { AccountPageData } from '../models/account-page-data';
import { AccountTabData, defaultAccountTabData, errorAccountTabData } from '../models/account-tab-data';

/**
 * A fan page no longer keeps the whole collection in the DOM. Bandcamp embeds the first batch of
 * every tab in a JSON blob on `#pagedata` and serves the rest from a paged API. Clicking tabs and
 * scrolling returns only what is already rendered, so both are skipped here.
 */
export const API_BASE = 'https://bandcamp.com/api/fancollection/1/';

/**
 * Items per API request. The API advances only about 20 new records per call whatever `count` is,
 * a larger value just returns the same records again (about 4.5 times as many duplicates for 100).
 */
export const API_PAGE_SIZE = 20;

/** Stops a fan with a huge collection from holding a worker forever. */
export const API_PAGE_LIMIT = 200;

/** Answer of one API call. `body` is the parsed JSON, set only when the status is OK. */
export interface ApiAnswer {
	status: number;
	/** Raw `Retry-After` header value, if any. */
	retryAfter?: string;
	body?: any;
}

/** Sends one POST request to the fan collection API. How it is sent depends on the reader. */
export type ApiRequest = (endpoint: string, body: object) => Promise<ApiAnswer>;

export interface TabSource {
	/** Key inside `item_cache` holding the batch embedded in the page. */
	cacheKey: string;
	/** Key of the blob section holding the total and the pagination token. */
	dataKey: string;
	/** API method serving the rest of the tab. */
	endpoint: string;
	/** Field of an API record holding the URL. */
	urlField: string;
	isValidUrl: (url: string) => boolean;
}

export const TAB_SOURCES: { [tab in AccountTab]: TabSource } = {
	[AccountTab.Collection]: {
		cacheKey: 'collection',
		dataKey: 'collection_data',
		endpoint: 'collection_items',
		urlField: 'item_url',
		isValidUrl: isItemUrl,
	},
	[AccountTab.Wishlist]: {
		cacheKey: 'wishlist',
		dataKey: 'wishlist_data',
		endpoint: 'wishlist_items',
		urlField: 'item_url',
		isValidUrl: isItemUrl,
	},
	[AccountTab.Followers]: {
		cacheKey: 'followers',
		dataKey: 'followers_data',
		endpoint: 'followers',
		urlField: 'trackpipe_url',
		isValidUrl: isAccountUrl,
	},
	[AccountTab.Following]: {
		cacheKey: 'following_fans',
		dataKey: 'following_fans_data',
		endpoint: 'following_fans',
		urlField: 'trackpipe_url',
		isValidUrl: isAccountUrl,
	},
};

/**
 * Builds the page data of an account from the `#pagedata` blob, reading the rest of every tab
 * through `requestApi`.
 *
 * @param url - URL of the account page.
 * @param blob - The parsed `#pagedata` blob.
 * @param requestApi - Sends one API request.
 */
export async function buildAccountPageData(
	url: string,
	blob: any,
	requestApi: ApiRequest,
): Promise<AccountPageData> {
	const collection = await readAccountTab(url, blob, AccountTab.Collection, requestApi);
	const wishlist = await readAccountTab(url, blob, AccountTab.Wishlist, requestApi);
	const following = await readAccountTab(url, blob, AccountTab.Following, requestApi);
	const followers = await readAccountTab(url, blob, AccountTab.Followers, requestApi);

	return {
		url,
		collection,
		wishlist,
		following,
		followers,
		errors: [collection, wishlist, following, followers].map(x => x.error).filter(x => !isNullOrUndefined(x))
	}
}

/**
 * Collects every URL of the specified account tab: the batch embedded in the page, then the rest
 * from the API.
 */
async function readAccountTab(
	pageUrl: string,
	blob: any,
	tabType: AccountTab,
	requestApi: ApiRequest,
): Promise<AccountTabData> {
	try {
		const source: TabSource = TAB_SOURCES[tabType];

		const total: number = blob[source.dataKey]?.item_count ?? 0;
		if (total <= 0) {
			return defaultAccountTabData;
		}

		const embedded: string[] = readEmbeddedUrls(blob, source);
		const { urls: fetched, refused } = await fetchRemainingUrls(blob, source, requestApi);

		// Keeping what arrived before the refusal would stamp a half-read account as processed.
		if (refused?.status === 429) {
			throw new RateLimitedError(pageUrl, refused.retryAfter);
		}
		// A truncated tab must not be saved as a complete one, so this fails the whole account.
		if (!isNullOrUndefined(refused)) {
			throw new ApiRefusedError(`Fan collection API refused "${source.endpoint}" with status ${refused.status}`);
		}

		const urls = [...embedded, ...fetched]
			.filter(x => !isNullOrUndefined(x))
			.map(x => originalUrl(x))
			.filter(x => source.isValidUrl(x));

		return { total, urls: [...new Set(urls)] };
	} catch (e) {
		if (e instanceof RateLimitedError || e instanceof ApiRefusedError) {
			throw e;
		}
		return errorAccountTabData(e);
	}
}

/**
 * Reads the URLs of the batch the page already carries, so the first API page can be skipped.
 */
function readEmbeddedUrls(blob: any, source: TabSource): string[] {
	const cache = blob.item_cache?.[source.cacheKey];
	if (isNullOrUndefined(cache)) {
		return [];
	}

	return Object.values(cache)
		.map((record: any) => record?.[source.urlField])
		.filter((x: string) => !isNullOrUndefined(x));
}

/**
 * Walks the API from the token the page was rendered with until it runs out of pages.
 *
 * @returns The URLs of every record after the embedded batch, and the answer that stopped the walk.
 */
async function fetchRemainingUrls(
	blob: any,
	source: TabSource,
	requestApi: ApiRequest,
): Promise<{ urls: string[], refused: ApiAnswer | null }> {
	const urls: string[] = [];

	const fanId: number = blob.fan_data?.fan_id;
	const firstToken: string = blob[source.dataKey]?.last_token;
	if (isNullOrUndefined(fanId) || isNullOrUndefined(firstToken)) {
		return { urls, refused: null };
	}

	let token: string = firstToken;
	for (let i = 0; i < API_PAGE_LIMIT && !!token; i++) {
		const answer = await requestApi(source.endpoint, { fan_id: fanId, older_than_token: token, count: API_PAGE_SIZE });
		if (answer.status < 200 || answer.status >= 300) {
			return { urls, refused: answer };
		}

		const body = answer.body;

		// Follower tabs answer with `followeers`, item tabs with `items`.
		const records: any[] = body.followeers ?? body.items ?? [];
		for (const record of records) {
			if (record?.[source.urlField]) {
				urls.push(record[source.urlField]);
			}
		}

		// The token repeats itself once the last page is reached.
		if (!body.more_available || !body.last_token || body.last_token === token) {
			break;
		}
		token = body.last_token;
	}

	return { urls, refused: null };
}
