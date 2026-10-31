import * as cheerio from 'cheerio';
import { HttpClient } from '../../../common/http-client';
import { isNullOrUndefined } from '../../../common/utils';
import { AccountPageData } from '../models/account-page-data';
import { API_BASE, buildAccountPageData } from './account-page-common';

/**
 * Reads an account page with plain HTTP requests. Gives the same data as `readAccountPage`.
 *
 * @throws 'Page did not exist' for HTTP 404 or a page without `#pagedata`, `RateLimitedError` for
 * HTTP 429, a normal error for any other failure.
 */
export async function readAccountPageByFetch(
	url: string,
	http: HttpClient,
): Promise<AccountPageData> {
	const response = await http.get(url);
	if (response.status === 404) {
		throw new Error('Page did not exist');
	}
	if (response.status !== 200) {
		throw new Error(`HTTP ${response.status}: ${url}`);
	}

	const blob = readPageBlob(response.body);
	if (isNullOrUndefined(blob)) {
		throw new Error('Page did not exist');
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
function readPageBlob(html: string): any {
	try {
		return JSON.parse(cheerio.load(html)('#pagedata').attr('data-blob'));
	} catch {
		return null;
	}
}
