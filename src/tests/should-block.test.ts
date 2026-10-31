import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ACCOUNT_NAVIGATION_TIMEOUT_MS } from '../core/account/clients/account-page-client';
import {
	BROWSER_RELAUNCH_INTERVAL,
	BROWSERLESS_ENDPOINT,
	CHROME_ARGS,
	PAGE_RECREATE_INTERVAL,
	shouldBlock,
} from '../core/browser/browser-page-source';
import { ITEM_NAVIGATION_TIMEOUT_MS } from '../core/item/clients/item-page-client';

const request = (resourceType: string, method: string, url: string) => ({
	resourceType: () => resourceType,
	method: () => method,
	url: () => url,
});

describe('shouldBlock', () => {
	// [resource type, method, url, blocked]
	const table: [string, string, string, boolean][] = [
		['document', 'GET', 'https://band.bandcamp.com/album/x', false],
		['script', 'GET', 'https://s4.bcbits.com/bundle/x.js', false],
		['xhr', 'GET', 'https://band.bandcamp.com/api/x', false],
		['font', 'GET', 'https://band.bandcamp.com/x.woff', true],
		['image', 'GET', 'https://f4.bcbits.com/img/a1.jpg', true],
		['media', 'GET', 'https://t4.bcbits.com/stream/x', true],
		['xhr', 'POST', 'https://bandcamp.com/api/fancollection/1/collection_items', false],
		['xhr', 'POST', 'https://bandcamp.com/api/fancollection/1/followers', false],
		['xhr', 'POST', 'https://bandcamp.com/api/tralbumcollectors/2/thumbs', true],
		['xhr', 'POST', 'https://band.bandcamp.com/api/anything', true],
		['script', 'GET', 'https://www.google.com/recaptcha/api.js', true],
		['script', 'GET', 'https://www.gstatic.com/x.js', true],
		['script', 'GET', 'https://www.googletagmanager.com/gtag/js', true],
		['xhr', 'GET', 'https://bandcamp.com/api/currency_data/1/x', true],
		['xhr', 'GET', 'https://band.bandcamp.com/?ref=google.com', true],
	];

	for (const [type, method, url, blocked] of table) {
		it(`${blocked ? 'blocks' : 'keeps'} ${type} ${method} ${url}`, () => {
			assert.equal(shouldBlock(request(type, method, url)), blocked);
		});
	}
});

describe('browser constants', () => {
	it('keep their values', () => {
		assert.equal(PAGE_RECREATE_INTERVAL, 1);
		assert.equal(BROWSER_RELAUNCH_INTERVAL, 500);
		assert.equal(BROWSERLESS_ENDPOINT, 'ws://localhost:3000');
		assert.equal(ITEM_NAVIGATION_TIMEOUT_MS, 3_500);
		assert.equal(ACCOUNT_NAVIGATION_TIMEOUT_MS, 3_000);
	});

	it('keep the Chrome flags in the same order', () => {
		assert.deepEqual(CHROME_ARGS, [
			'--disable-accelerated-2d-canvas',
			'--disable-background-timer-throttling',
			'--disable-backgrounding-occluded-windows',
			'--disable-breakpad',
			'--disable-client-side-phishing-detection',
			'--disable-component-extensions-with-background-pages',
			'--disable-default-apps',
			'--disable-dev-shm-usage',
			'--disable-extensions',
			'--disable-gpu',
			'--disable-infobars',
			'--disable-popup-blocking',
			'--disable-setuid-sandbox',
			'--dns-server=1.1.1.1',
			'--ignore-certificate-errors',
			'--incognito',
			'--no-first-run',
			'--no-sandbox',
			'--no-zygote',
			'--performance',
			'--window-size=1200,800',
		]);
	});
});
