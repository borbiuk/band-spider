import { Page } from 'puppeteer';
import {
	delay,
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
import { RateLimitedError } from '../../../common/rate-limit-gate';
import { ProxyClient } from '../../proxy/proxy-client';
import { ItemPageData } from '../models/item-page-data';
import { defaultItemTabData, errorItemData, ItemTabData } from '../models/item-tab-data';

const NOT_FOUND_TITLE = 'Sorry, that something isn’t here.';

/** Everything the item page needs, read in the browser with one call. `null` means the selector matched nothing. */
interface RawItemPage {
	notFound: boolean,
	accounts: (string | null)[],
	tags: string[],
	credits: string | null,
	albumLink: { href: string | null } | null | undefined,
	trackLinks: (string | null)[] | undefined,
	image: { src: string } | null,
}

/** Same as the error that `page.$eval` throws when its selector matches nothing. */
const selectorNotFound = (selector: string): Error =>
	new Error(`Error: failed to find element matching selector "${selector}"`);

export async function readItemPage(
	url: string,
	page: Page,
): Promise<ItemPageData> {
	try {
		const response = await page.goto(url, { timeout: 3_500, waitUntil: 'domcontentloaded' });
		if (response?.status() === 429) {
			throw new RateLimitedError(url, response.headers()['retry-after']);
		}
	} catch (e) {
		if (!(e instanceof RateLimitedError) && e.message.includes('Navigation timeout')) {
			await ProxyClient.initialize.changeIp();
		}

		throw e;
	}

	const wantAlbum = isTrackUrl(url);
	const wantTracks = isAlbumUrl(url);

	// One round trip to the browser instead of one per field.
	let raw: RawItemPage;
	let readError: Error = null;
	try {
		raw = await page.evaluate(({ wantAlbum, wantTracks, notFoundTitle }) => {
			const h2 = document.querySelector('h2');
			const credits = document.querySelector('.tralbumData.tralbum-credits');
			const albumLink = document.querySelector('#buyAlbumLink');
			const image = document.querySelector<HTMLImageElement>('#tralbumArt img');

			return {
				notFound: h2 !== null && h2.textContent.trim() === notFoundTitle,
				accounts: Array.from(document.querySelectorAll('a.fan.pic')).map(x => x.getAttribute('href')),
				tags: Array.from(document.querySelectorAll('a.tag')).map(x => x.textContent.trim()),
				credits: credits === null ? null : credits.textContent,
				albumLink: wantAlbum
					? (albumLink === null ? null : { href: albumLink.getAttribute('href') })
					: undefined,
				trackLinks: wantTracks
					? Array.from(document.querySelectorAll('table.track_list#track_table a')).map(x => x.getAttribute('href'))
					: undefined,
				image: image === null ? null : { src: image.src },
			};
		}, { wantAlbum, wantTracks, notFoundTitle: NOT_FOUND_TITLE });
	} catch (e) {
		// as before, a failed read gives an error for every field instead of throwing
		readError = e;
	}

	if (raw?.notFound) {
		throw new Error('Page did not exist');
	}

	const accounts = readError ? errorItemData<string[]>(readError) : readPageAccounts(raw.accounts);
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
		: (raw.image === null ? errorItemData(selectorNotFound('#tralbumArt img')) : { data: raw.image.src });

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
	// TODO: button click did not working in headless mode, so only the first 60 accounts are read
	const urls = hrefs
		.map(x => originalUrl(x))
		.filter(x => isAccountUrl(x));

	return { data: urls, };
}

function parseReleaseDate(content: string | null): ItemTabData<Date> {
	if (content === null) {
		return errorItemData(selectorNotFound('.tralbumData.tralbum-credits'));
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

	if (albumLink === null) {
		return errorItemData(selectorNotFound('#buyAlbumLink'));
	}

	return isEmptyString(albumLink.href)
		? defaultItemTabData()
		: { data: domain + albumLink.href };
}

async function loadAllAccount(page: Page): Promise<void> {
	while (true) {
		try {
			const showMoreAccountsButton = await page.$('a.more-thumbs');
			if (isNullOrUndefined(showMoreAccountsButton)) {
				break;
			}
			await showMoreAccountsButton?.click();
			await delay();
		} catch {
			break;
		}
	}
}
