import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ApiRefusedError, HttpStatusError, PageNotFoundError } from '../common/errors';
import { getPageHtml, HttpClient } from '../common/http-client';
import { RateLimitedError, RateLimitGate } from '../common/rate-limit-gate';
import { buildAccountPageData } from '../core/account/clients/account-page-common';
import { buildItemPageData } from '../core/item/clients/item-page-common';

/** A client whose every request is answered with the given status and body. */
const clientAnswering = (status: number, body = '', headers: Record<string, string> = {}): HttpClient =>
	new HttpClient(new RateLimitGate({ sleep: async () => { } }), {
		fetchFn: async () => new Response(body, { status, headers }),
		minDelayMs: 0,
		maxDelayMs: 0,
	});

const url = 'https://band.bandcamp.com/album/x';

describe('error classes', () => {
	it('keep the messages the code used before', () => {
		assert.equal(new PageNotFoundError().message, 'Page did not exist');
		assert.equal(new HttpStatusError(500, url).message, `HTTP 500: ${url}`);
		assert.equal(new ApiRefusedError('refused').message, 'refused');
	});

	it('are plain errors for logs and stack traces', () => {
		for (const error of [new PageNotFoundError(), new HttpStatusError(503, url), new ApiRefusedError('x')]) {
			assert.ok(error instanceof Error);
			assert.equal(error.name, 'Error');
		}
	});

	it('HttpStatusError carries the status and the URL', () => {
		const error = new HttpStatusError(503, url);
		assert.equal(error.status, 503);
		assert.equal(error.url, url);
	});
});

describe('getPageHtml', () => {
	it('returns the body for HTTP 200', async () => {
		assert.equal(await getPageHtml(clientAnswering(200, '<html></html>'), url), '<html></html>');
	});

	it('throws PageNotFoundError for HTTP 404', async () => {
		await assert.rejects(getPageHtml(clientAnswering(404), url), (e: unknown) => e instanceof PageNotFoundError);
	});

	it('throws HttpStatusError for other statuses', async () => {
		for (const status of [201, 301, 403, 500]) {
			await assert.rejects(getPageHtml(clientAnswering(status), url), (e: unknown) => {
				assert.ok(e instanceof HttpStatusError);
				assert.equal(e.status, status);
				return true;
			});
		}
	});

	it('throws RateLimitedError for HTTP 429', async () => {
		await assert.rejects(getPageHtml(clientAnswering(429, '', { 'retry-after': '3' }), url), RateLimitedError);
	});
});

describe('page builders throw the error classes', () => {
	it('the "not found" item page gives PageNotFoundError', () => {
		assert.throws(
			() => buildItemPageData(url, { notFound: true, accounts: [], tags: [], credits: null, albumLink: null, trackLinks: [], image: null }, null),
			PageNotFoundError,
		);
	});

	it('a refused fan API call gives ApiRefusedError', async () => {
		const blob = {
			fan_data: { fan_id: 1 },
			collection_data: { item_count: 5, last_token: 't' },
			wishlist_data: { item_count: 0 },
			followers_data: { item_count: 0 },
			following_fans_data: { item_count: 0 },
		};

		await assert.rejects(
			buildAccountPageData('https://bandcamp.com/fan', blob, async () => ({ status: 403 })),
			ApiRefusedError,
		);
	});
});
