import type { Page } from 'puppeteer';
import { PageNotFoundError } from '../../../common/errors';
import { RateLimitedError } from '../../../common/rate-limit-gate';
import { isNullOrUndefined } from '../../../common/utils';
import { AccountPageData } from '../models/account-page-data';
import { API_BASE, ApiAnswer, buildAccountPageData } from './account-page-common';

/** How long the browser waits for an account page to load. */
export const ACCOUNT_NAVIGATION_TIMEOUT_MS = 3_000;

/** Reads an account page in the browser. Used with the `--browser` flag. */
export async function readAccountPage(
	url: string,
	page: Page,
): Promise<AccountPageData> {
	const response = await page.goto(url, { timeout: ACCOUNT_NAVIGATION_TIMEOUT_MS, waitUntil: 'domcontentloaded' });
	if (response?.status() === 429) {
		throw new RateLimitedError(url, response.headers()['retry-after']);
	}

	const blob = await readPageBlob(page);
	if (isNullOrUndefined(blob)) {
		throw new PageNotFoundError();
	}

	return await buildAccountPageData(url, blob, (endpoint, body) => requestApi(page, endpoint, body));
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
 * Sends one API request from the page itself, so that it carries the same origin and headers as
 * the ones the fan page makes on its own.
 */
async function requestApi(page: Page, endpoint: string, body: object): Promise<ApiAnswer> {
	return await page.evaluate(
		async (apiUrl, requestBody) => {
			const response = await fetch(apiUrl, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(requestBody)
			});

			return {
				status: response.status,
				retryAfter: response.headers.get('retry-after') ?? undefined,
				body: response.ok ? await response.json() : undefined,
			};
		},
		API_BASE + endpoint, body
	);
}
