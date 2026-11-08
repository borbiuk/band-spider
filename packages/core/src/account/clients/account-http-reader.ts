import * as cheerio from 'cheerio';
import { UnexpectedPageError } from '../../common/errors';
import { getPageHtml, HttpClient } from '../../common/http-client';
import { RateLimitedError } from '../../common/rate-limit-gate';
import { isNullOrUndefined } from '../../common/utils';
import { AccountScanMarks } from '../../models/account-scan-marks';
import { AccountPageData } from '../models/account-page-data';
import { ACCOUNT_SELECTORS, API_BASE, buildAccountPageData, FanPageBlob } from './account-page-common';

/**
 * Reads an account page with plain HTTP requests. Gives the same data as `readAccountPage`.
 *
 * @throws `PageNotFoundError` for HTTP 404, `RateLimitedError` for
 * HTTP 429, `ApiRefusedError` when the API refuses a request, a normal error for any other failure,
 * also for a page without `#pagedata`: a block or error page of a proxy can come with status 200.
 */
export async function readAccountPageByFetch(
	url: string,
	http: HttpClient,
	marks: AccountScanMarks = {},
): Promise<AccountPageData> {
	const html = await getPageHtml(http, url);

	const blob = readPageBlob(html);
	if (isNullOrUndefined(blob)) {
		throw new UnexpectedPageError('The account page has no "#pagedata" blob', url);
	}

	return await buildAccountPageData(url, blob, async (endpoint, body) => {
		const answer = await http.postJson(API_BASE + endpoint, body);
		return {
			status: answer.status,
			body: answer.status >= 200 && answer.status < 300 ? JSON.parse(answer.body) : undefined,
		};
	}, marks);
}

/**
 * A control request: loads an account page that is known to exist and tells whether it came as
 * expected (status 200 with `#pagedata`). The tabs are not read.
 *
 * @throws `RateLimitedError` for HTTP 429: that says nothing about the proxy.
 */
export async function isAccountPageReadable(url: string, http: HttpClient): Promise<boolean> {
	let html: string;
	try {
		html = await getPageHtml(http, url);
	} catch (e) {
		if (e instanceof RateLimitedError) {
			throw e;
		}
		return false;
	}
	return !isNullOrUndefined(readPageBlob(html));
}

/** Reads the JSON blob the page embeds for its own front-end. Null when the page carries none. */
function readPageBlob(html: string): FanPageBlob | null {
	try {
		return JSON.parse(cheerio.load(html)(ACCOUNT_SELECTORS.pageBlob).attr('data-blob'));
	} catch {
		return null;
	}
}
