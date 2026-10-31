import { Page } from 'puppeteer';
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
const API_BASE = 'https://bandcamp.com/api/fancollection/1/';

/** Items per API request. Bandcamp accepts larger pages than the 20 it renders by default. */
const API_PAGE_SIZE = 100;

/** Stops a fan with a huge collection from holding a browser forever. */
const API_PAGE_LIMIT = 200;

/**
 * Marks the error raised when the API refuses a request. A truncated tab must not be saved as a
 * complete one, so this travels up and fails the whole account instead.
 */
const RATE_LIMITED = Symbol('rateLimited');

interface TabSource {
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

const TAB_SOURCES: { [tab in AccountTab]: TabSource } = {
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

export async function readAccountPage(
	url: string,
	page: Page,
): Promise<AccountPageData> {
	const response = await page.goto(url, { timeout: 3_000, waitUntil: 'domcontentloaded' });
	if (response?.status() === 429) {
		throw new RateLimitedError(url, response.headers()['retry-after']);
	}

	const blob = await readPageBlob(page);
	if (isNullOrUndefined(blob)) {
		throw new Error('Page did not exist');
	}

	const collection = await readAccountTab(page, blob, AccountTab.Collection);
	const wishlist = await readAccountTab(page, blob, AccountTab.Wishlist);
	const following = await readAccountTab(page, blob, AccountTab.Following);
	const followers = await readAccountTab(page, blob, AccountTab.Followers);

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
 * Reads the JSON blob the page embeds for its own front-end.
 *
 * @param page - Puppeteer page instance.
 * @returns A promise that resolves to the parsed blob, or null when the page carries none.
 */
async function readPageBlob(page: Page): Promise<any> {
	return await page
		.$eval('#pagedata', element => JSON.parse(element.getAttribute('data-blob')))
		.catch(() => null);
}

/**
 * Collects every URL of the specified account tab: the batch embedded in the page, then the rest
 * from the API.
 *
 * @param page - Puppeteer page instance.
 * @param blob - The parsed `#pagedata` blob.
 * @param tabType - Type of account tab to read.
 * @returns A promise that resolves to the total number of items and their URLs.
 */
async function readAccountTab(page: Page, blob: any, tabType: AccountTab): Promise<AccountTabData> {
	try {
		const source: TabSource = TAB_SOURCES[tabType];

		const total: number = blob[source.dataKey]?.item_count ?? 0;
		if (total <= 0) {
			return defaultAccountTabData;
		}

		const embedded: string[] = readEmbeddedUrls(blob, source);
		const { urls: fetched, refusedStatus } = await fetchRemainingUrls(page, blob, source);

		// Keeping what arrived before the refusal would stamp a half-read account as processed.
		if (refusedStatus === 429) {
			throw new RateLimitedError(page.url());
		}
		if (!isNullOrUndefined(refusedStatus)) {
			const error = new Error(`Fan collection API refused "${source.endpoint}" with status ${refusedStatus}`);
			error[RATE_LIMITED] = true;
			throw error;
		}

		const urls = [...embedded, ...fetched]
			.filter(x => !isNullOrUndefined(x))
			.map(x => originalUrl(x))
			.filter(x => source.isValidUrl(x));

		return { total, urls: [...new Set(urls)] };
	} catch (e) {
		if (e instanceof RateLimitedError || e?.[RATE_LIMITED]) {
			throw e;
		}
		return errorAccountTabData(e);
	}
}

/**
 * Reads the URLs of the batch the page already carries, so the first API page can be skipped.
 *
 * @param blob - The parsed `#pagedata` blob.
 * @param source - Where the tab keeps its data inside the blob.
 * @returns The URLs found in the blob.
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
 * The request is issued from the page itself so that it carries the same origin and headers as the
 * ones the fan page makes on its own.
 *
 * @param page - Puppeteer page instance.
 * @param blob - The parsed `#pagedata` blob.
 * @param source - Where the tab keeps its data inside the blob.
 * @returns The URLs of every record after the embedded batch, and the status that stopped the walk.
 */
async function fetchRemainingUrls(
	page: Page,
	blob: any,
	source: TabSource
): Promise<{ urls: string[], refusedStatus: number }> {
	const fanId: number = blob.fan_data?.fan_id;
	const firstToken: string = blob[source.dataKey]?.last_token;
	if (isNullOrUndefined(fanId) || isNullOrUndefined(firstToken)) {
		return { urls: [], refusedStatus: null };
	}

	return await page.evaluate(
		async (apiBase, endpoint, fanId, firstToken, urlField, pageSize, pageLimit) => {
			const urls: string[] = [];
			let token: string = firstToken;

			for (let i = 0; i < pageLimit && !!token; i++) {
				const response = await fetch(apiBase + endpoint, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ fan_id: fanId, older_than_token: token, count: pageSize })
				});
				if (!response.ok) {
					return { urls, refusedStatus: response.status };
				}

				const body = await response.json();

				// Follower tabs answer with `followeers`, item tabs with `items`.
				const records: any[] = body.followeers ?? body.items ?? [];
				for (const record of records) {
					if (record?.[urlField]) {
						urls.push(record[urlField]);
					}
				}

				// The token repeats itself once the last page is reached.
				if (!body.more_available || !body.last_token || body.last_token === token) {
					break;
				}
				token = body.last_token;
			}

			return { urls, refusedStatus: null };
		},
		API_BASE, source.endpoint, fanId, firstToken, source.urlField, API_PAGE_SIZE, API_PAGE_LIMIT
	);
}
