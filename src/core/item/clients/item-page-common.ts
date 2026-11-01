import { PageNotFoundError } from '../../../common/errors';
import {
	isAccountUrl,
	isAlbumUrl,
	isEmptyString,
	isNullOrUndefined,
	isTrackUrl,
	isValidDate,
	isValidUrl,
	onlyUnique,
	originalUrl
} from '../../../common/utils';
import { ItemPageData } from '../models/item-page-data';
import { defaultItemTabData, errorItemData, ItemTabData } from '../models/item-tab-data';

export const NOT_FOUND_TITLE = 'Sorry, that something isn’t here.';

/** CSS selectors of the item page. Both readers use them, so they read the same elements. */
export const ITEM_SELECTORS = {
	/** Its text is `NOT_FOUND_TITLE` on the "not found" page. */
	title: 'h2',
	credits: '.tralbumData.tralbum-credits',
	albumLink: '#buyAlbumLink',
	image: '#tralbumArt img',
	/** The supporters rendered in the page. */
	supporters: 'a.fan.pic',
	tags: 'a.tag',
	trackLinks: 'table.track_list#track_table a',
	/** JSON of the first supporters and whether more exist. Only the HTTP reader uses it. */
	supportersBlob: '#collectors-data',
	/** JSON with the id and the type of the item. Only the HTTP reader uses it. */
	tralbum: '[data-tralbum]',
} as const;

/** Everything the item page needs, read from the page. `null` means the selector matched nothing. */
export interface RawItemPage {
	notFound: boolean,
	accounts: (string | null)[],
	/** Set when the supporters could not be read completely. They are then reported as an error. */
	accountsError?: Error,
	tags: string[],
	credits: string | null,
	albumLink: { href: string | null } | null | undefined,
	trackLinks: (string | null)[] | undefined,
	image: { src: string } | null,
}

/** Same as the error that `page.$eval` throws when its selector matches nothing. */
export const selectorNotFound = (selector: string): Error =>
	new Error(`Error: failed to find element matching selector "${selector}"`);

/**
 * Builds the page data from what a reader found on the page.
 *
 * @param url - URL of the item page.
 * @param raw - The raw page content, undefined when reading it failed.
 * @param readError - The error of a failed read. It is reported for every field.
 * @throws `PageNotFoundError` when the page is the "not found" page.
 */
export function buildItemPageData(
	url: string,
	raw: RawItemPage | undefined,
	readError: Error | null,
): ItemPageData {
	if (raw?.notFound) {
		throw new PageNotFoundError();
	}

	const wantAlbum = isTrackUrl(url);
	const wantTracks = isAlbumUrl(url);

	const accounts = readError
		? errorItemData<string[]>(readError)
		: (raw.accountsError ? errorItemData<string[]>(raw.accountsError) : readPageAccounts(raw.accounts));
	const tags: ItemTabData<string[]> = readError ? errorItemData(readError) : { data: raw.tags };
	const releaseDate = readError ? errorItemData<Date>(readError) : parseReleaseDate(raw.credits);

	const album = wantAlbum
		? (readError ? errorItemData<string>(readError) : parseTrackAlbum(raw.albumLink, url))
		: defaultItemTabData<string>();
	const tracks = wantTracks
		? (readError ? errorItemData<string[]>(readError) : parseAlbumTracks(raw.trackLinks, url))
		: defaultItemTabData<string[]>();

	const imageUrl: ItemTabData<string> = readError
		? errorItemData(readError)
		: (raw.image === null ? errorItemData(selectorNotFound(ITEM_SELECTORS.image)) : { data: raw.image.src });

	return {
		url,
		accounts,
		tags,
		releaseDate,
		album,
		tracks,
		imageUrl,
		errors: [accounts.error, tags.error, releaseDate.error, album.error, tracks.error, imageUrl.error].filter(x => !isNullOrUndefined(x))
	};
}

function readPageAccounts(hrefs: (string | null)[]): ItemTabData<string[]> {
	const urls = hrefs
		.map(x => originalUrl(x))
		.filter(x => isAccountUrl(x));

	return { data: urls, };
}

function parseReleaseDate(content: string | null): ItemTabData<Date> {
	if (content === null) {
		return errorItemData(selectorNotFound(ITEM_SELECTORS.credits));
	}

	const match = content.match(/(?:released|releases) (\w+ \d{1,2}, \d{4})/);
	if (isNullOrUndefined(match) || match.length <= 1 || isNullOrUndefined(match[1])) {
		return defaultItemTabData();
	}

	const date: Date = new Date(match[1]);
	return isValidDate(date)
		? { data: date }
		: defaultItemTabData();
}

function parseAlbumTracks(trackLinks: (string | null)[], url: string): ItemTabData<string[]> {
	const { hostname, protocol } = new URL(url);
	const domain = protocol + '//' + hostname;

	const urls = trackLinks
		.filter(x => !isNullOrUndefined(x))
		.map(x => domain + originalUrl(x))
		.filter(x => isValidUrl(x))
		.filter(onlyUnique);

	return { data: urls };
}

function parseTrackAlbum(albumLink: { href: string | null } | null, url: string): ItemTabData<string> {
	const { hostname, protocol } = new URL(url);
	const domain = protocol + '//' + hostname;

	// a single track is not part of an album, so its page has no album link
	return albumLink === null || isEmptyString(albumLink.href)
		? defaultItemTabData()
		: { data: domain + albumLink.href };
}
