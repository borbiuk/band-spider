import type { Page } from 'puppeteer';
import { isAlbumUrl, isTrackUrl } from '../../../common/utils';
import { asError, errorMessage } from '../../../common/errors';
import { RateLimitedError } from '../../../common/rate-limit-gate';
import { ProxyClient } from '../../proxy/proxy-client';
import { ItemPageData } from '../models/item-page-data';
import { buildItemPageData, ITEM_SELECTORS, NOT_FOUND_TITLE, RawItemPage } from './item-page-common';

/** How long the browser waits for an item page to load. */
export const ITEM_NAVIGATION_TIMEOUT_MS = 3_500;

/** Reads an item page in the browser. Used with the `--browser` flag. */
export async function readItemPage(
	url: string,
	page: Page,
): Promise<ItemPageData> {
	try {
		const response = await page.goto(url, { timeout: ITEM_NAVIGATION_TIMEOUT_MS, waitUntil: 'domcontentloaded' });
		if (response?.status() === 429) {
			throw new RateLimitedError(url, response.headers()['retry-after']);
		}
	} catch (e) {
		if (!(e instanceof RateLimitedError) && errorMessage(e).includes('Navigation timeout')) {
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
		// The function runs in the browser, so the selectors are passed in as an argument.
		raw = await page.evaluate(({ wantAlbum, wantTracks, notFoundTitle, selectors }) => {
			const h2 = document.querySelector(selectors.title);
			const credits = document.querySelector(selectors.credits);
			const albumLink = document.querySelector(selectors.albumLink);
			const image = document.querySelector<HTMLImageElement>(selectors.image);

			return {
				notFound: h2 !== null && h2.textContent.trim() === notFoundTitle,
				accounts: Array.from(document.querySelectorAll(selectors.supporters)).map(x => x.getAttribute('href')),
				tags: Array.from(document.querySelectorAll(selectors.tags)).map(x => x.textContent.trim()),
				credits: credits === null ? null : credits.textContent,
				albumLink: wantAlbum
					? (albumLink === null ? null : { href: albumLink.getAttribute('href') })
					: undefined,
				trackLinks: wantTracks
					? Array.from(document.querySelectorAll(selectors.trackLinks)).map(x => x.getAttribute('href'))
					: undefined,
				image: image === null ? null : { src: image.src },
			};
		}, { wantAlbum, wantTracks, notFoundTitle: NOT_FOUND_TITLE, selectors: ITEM_SELECTORS });
	} catch (e) {
		// as before, a failed read gives an error for every field instead of throwing
		readError = asError(e);
	}

	// TODO: button click did not working in headless mode, so only the first 60 accounts are read
	return buildItemPageData(url, raw, readError);
}
