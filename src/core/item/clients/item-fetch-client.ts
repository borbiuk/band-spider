import * as cheerio from 'cheerio';
import { ApiRefusedError, asError } from '../../../common/errors';
import { getPageHtml, HttpClient, HttpResponse } from '../../../common/http-client';
import { RateLimitedError } from '../../../common/rate-limit-gate';
import { isAlbumUrl, isNullOrUndefined, isTrackUrl } from '../../../common/utils';
import { ItemPageData } from '../models/item-page-data';
import { buildItemPageData, NOT_FOUND_TITLE, RawItemPage } from './item-page-common';

/** Supporters per request to the thumbs API. */
const SUPPORTERS_PAGE_SIZE = 100;

/** Stops an item with a huge number of supporters from holding a worker forever. */
const SUPPORTERS_PAGE_LIMIT = 200;

/** Sends one JSON POST request. */
type PostJson = (url: string, body: unknown) => Promise<HttpResponse>;

interface Supporter {
	fan_id?: number,
	username?: string,
	url?: string,
	token?: string,
}

/**
 * Reads an item page with plain HTTP requests. Gives the same data as `readItemPage`, except that
 * all supporters are read, not only the 60 the page renders.
 *
 * @throws `PageNotFoundError` for HTTP 404, `RateLimitedError` for HTTP 429, `ApiRefusedError` when a
 * request for more supporters is refused, and a normal error for any other failure.
 */
export async function readItemPageByFetch(
	url: string,
	http: HttpClient,
): Promise<ItemPageData> {
	const html = await getPageHtml(http, url);

	const raw = await parseItemPage(url, html, http);
	return buildItemPageData(url, raw, null);
}

async function parseItemPage(url: string, html: string, http: HttpClient): Promise<RawItemPage> {
	const $ = cheerio.load(html);

	const wantAlbum = isTrackUrl(url);
	const wantTracks = isAlbumUrl(url);

	const h2 = $('h2').first();
	const credits = $('.tralbumData.tralbum-credits').first();
	const albumLink = $('#buyAlbumLink').first();
	const image = $('#tralbumArt img').first();

	const notFound = h2.length > 0 && h2.text().trim() === NOT_FOUND_TITLE;

	let accounts: (string | null)[] = [];
	let accountsError: Error | undefined;
	if (!notFound) {
		try {
			accounts = await readSupporters($, url, (apiUrl, body) => http.postJson(apiUrl, body));
		} catch (e) {
			// a refused request must not give a truncated list that looks complete
			if (e instanceof RateLimitedError || e instanceof ApiRefusedError) {
				throw e;
			}
			accountsError = asError(e);
		}
	}

	return {
		notFound,
		accounts,
		accountsError,
		tags: $('a.tag').map((_, x) => $(x).text().trim()).get(),
		credits: credits.length === 0 ? null : credits.text(),
		albumLink: wantAlbum
			? (albumLink.length === 0 ? null : { href: albumLink.attr('href') ?? null })
			: undefined,
		trackLinks: wantTracks
			? $('table.track_list#track_table a').map((_, x) => $(x).attr('href') ?? null).get()
			: undefined,
		image: image.length === 0 ? null : { src: new URL(image.attr('src') ?? '', url).href },
	};
}

/**
 * Reads the supporters: the first batch is embedded in `#collectors-data`, the rest comes from the
 * thumbs API of the same band host, one batch after another, until it says nothing is left.
 */
async function readSupporters($: cheerio.CheerioAPI, url: string, postJson: PostJson): Promise<string[]> {
	const blobText = $('#collectors-data').attr('data-blob');
	if (isNullOrUndefined(blobText)) {
		// no blob: fall back to the supporters rendered in the page
		return $('a.fan.pic').map((_, x) => $(x).attr('href') ?? null).get();
	}

	const blob = JSON.parse(blobText);
	const supporters: Supporter[] = [...(blob.thumbs ?? [])];
	let more: boolean = !!blob.more_thumbs_available;

	if (more) {
		const tralbum = JSON.parse($('[data-tralbum]').first().attr('data-tralbum') ?? 'null');
		if (isNullOrUndefined(tralbum?.id) || isNullOrUndefined(tralbum?.item_type)) {
			throw new Error('Supporters are not complete: "data-tralbum" is missing');
		}

		const apiUrl = new URL('/api/tralbumcollectors/2/thumbs', url).href;
		let token: string | undefined = supporters.at(-1)?.token;

		for (let i = 0; i < SUPPORTERS_PAGE_LIMIT && more && !isNullOrUndefined(token); i++) {
			const answer = await postJson(apiUrl, {
				tralbum_type: tralbum.item_type === 'album' ? 'a' : 't',
				tralbum_id: tralbum.id,
				token,
				count: SUPPORTERS_PAGE_SIZE,
			});
			if (answer.status !== 200) {
				throw new ApiRefusedError(`Supporters API refused with status ${answer.status}: ${apiUrl}`);
			}

			const body = JSON.parse(answer.body);
			const results: Supporter[] = body.results ?? [];
			supporters.push(...results);

			const nextToken = results.at(-1)?.token;
			// no new records or a token that does not move means the end
			more = !!body.more_available && results.length > 0 && nextToken !== token;
			token = nextToken;
		}
	}

	return [...new Set(supporters.map(x => x.url ?? (x.username ? `https://bandcamp.com/${x.username}` : null)))];
}
