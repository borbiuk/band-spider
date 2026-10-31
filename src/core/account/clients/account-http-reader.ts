import * as cheerio from 'cheerio';
import { PageNotFoundError } from '../../../common/errors';
import { getPageHtml, HttpClient } from '../../../common/http-client';
import { isNullOrUndefined } from '../../../common/utils';
import { AccountPageData } from '../models/account-page-data';
import { ACCOUNT_SELECTORS, API_BASE, buildAccountPageData, FanPageBlob } from './account-page-common';

/**
 * Reads an account page with plain HTTP requests. Gives the same data as `readAccountPage`.
 *
 * @throws `PageNotFoundError` for HTTP 404 or a page without `#pagedata`, `RateLimitedError` for
 * HTTP 429, `ApiRefusedError` when the API refuses a request, a normal error for any other failure.
 */
export async function readAccountPageByFetch(
	url: string,
	http: HttpClient,
): Promise<AccountPageData> {
	const html = await getPageHtml(http, url);

	const blob = readPageBlob(html);
	if (isNullOrUndefined(blob)) {
		throw new PageNotFoundError();
	}

	return await buildAccountPageData(url, blob, async (endpoint, body) => {
		const answer = await http.postJson(API_BASE + endpoint, body);
		return {
			status: answer.status,
			body: answer.status >= 200 && answer.status < 300 ? JSON.parse(answer.body) : undefined,
		};
	});
}

/** Reads the JSON blob the page embeds for its own front-end. Null when the page carries none. */
function readPageBlob(html: string): FanPageBlob | null {
	try {
		return JSON.parse(cheerio.load(html)(ACCOUNT_SELECTORS.pageBlob).attr('data-blob'));
	} catch {
		return null;
	}
}
