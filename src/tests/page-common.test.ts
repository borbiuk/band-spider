import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RateLimitedError } from '../common/rate-limit-gate';
import {
	API_PAGE_LIMIT,
	API_PAGE_SIZE,
	ApiAnswer,
	buildAccountPageData,
	TAB_SOURCES,
} from '../core/account/clients/account-page-common';
import { buildItemPageData, NOT_FOUND_TITLE, RawItemPage } from '../core/item/clients/item-page-common';
import { AccountTab } from '../models/account-tab';

const raw = (overrides: Partial<RawItemPage> = {}): RawItemPage => ({
	notFound: false,
	accounts: ['https://bandcamp.com/fan1?from=fanpub', 'https://bandcamp.com/fan2', 'https://band.bandcamp.com/', null],
	tags: ['techno', 'house'],
	credits: 'released March 1, 2024\nsome credits',
	albumLink: { href: '/album/the-album' },
	trackLinks: ['/track/a?action=download', '/track/b', '/track/a', null],
	image: { src: 'https://f4.bcbits.com/img/a1_2.jpg' },
	...overrides,
});

describe('buildItemPageData', () => {
	const albumUrl = 'https://band.bandcamp.com/album/the-album';
	const trackUrl = 'https://band.bandcamp.com/track/a';

	it('keeps the "not found" title text', () => {
		assert.equal(NOT_FOUND_TITLE, 'Sorry, that something isn’t here.');
	});

	it('throws "Page did not exist" for the not found page', () => {
		assert.throws(() => buildItemPageData(albumUrl, raw({ notFound: true }), null), { message: 'Page did not exist' });
	});

	it('reads an album page', () => {
		const data = buildItemPageData(albumUrl, raw(), null);

		assert.equal(data.url, albumUrl);
		assert.deepEqual(data.errors, []);
		assert.deepEqual(data.accounts, { data: ['https://bandcamp.com/fan1', 'https://bandcamp.com/fan2'] });
		assert.deepEqual(data.tags, { data: ['techno', 'house'] });
		assert.equal(data.releaseDate.data.getFullYear(), 2024);
		assert.equal(data.releaseDate.data.getMonth(), 2);
		assert.equal(data.releaseDate.data.getDate(), 1);
		assert.deepEqual(data.album, { data: null }, 'an album has no album link');
		assert.deepEqual(data.tracks, { data: ['https://band.bandcamp.com/track/a', 'https://band.bandcamp.com/track/b'] });
		assert.deepEqual(data.imageUrl, { data: 'https://f4.bcbits.com/img/a1_2.jpg' });
	});

	it('reads a track page with its album link', () => {
		const data = buildItemPageData(trackUrl, raw(), null);

		assert.deepEqual(data.errors, []);
		assert.deepEqual(data.album, { data: 'https://band.bandcamp.com/album/the-album' });
		assert.deepEqual(data.tracks, { data: null }, 'a track has no track list');
	});

	it('gives no album for a track without an album link', () => {
		assert.deepEqual(buildItemPageData(trackUrl, raw({ albumLink: { href: '' } }), null).album, { data: null });
		assert.deepEqual(buildItemPageData(trackUrl, raw({ albumLink: { href: null } }), null).album, { data: null });
	});

	it('reports a missing album link element as an error', () => {
		const data = buildItemPageData(trackUrl, raw({ albumLink: null }), null);

		assert.equal(data.album.data, null);
		assert.equal(data.album.error.message, 'Error: failed to find element matching selector "#buyAlbumLink"');
		assert.deepEqual(data.errors, [data.album.error]);
	});

	it('reports a missing credits element and a missing image as errors', () => {
		const data = buildItemPageData(albumUrl, raw({ credits: null, image: null }), null);

		assert.equal(data.releaseDate.error.message, 'Error: failed to find element matching selector ".tralbumData.tralbum-credits"');
		assert.equal(data.imageUrl.error.message, 'Error: failed to find element matching selector "#tralbumArt img"');
		assert.equal(data.errors.length, 2);
	});

	it('reads the release date from "released" and "releases" only', () => {
		const date = (credits: string) => buildItemPageData(albumUrl, raw({ credits }), null).releaseDate;

		assert.equal(date('releases December 24, 2030').data.getFullYear(), 2030);
		assert.deepEqual(date('recorded March 1, 2024'), { data: null });
		assert.deepEqual(date('released sometime'), { data: null });
		assert.deepEqual(date(''), { data: null });
	});

	it('does not ask for album or tracks on a URL that is neither', () => {
		const data = buildItemPageData('https://band.bandcamp.com/music', raw({ albumLink: null, trackLinks: undefined }), null);

		assert.deepEqual(data.album, { data: null });
		assert.deepEqual(data.tracks, { data: null });
		assert.deepEqual(data.errors, []);
	});

	it('reports the read error for every field', () => {
		const error = new Error('boom');
		const data = buildItemPageData(albumUrl, undefined, error);

		assert.deepEqual(data.accounts, { data: null, error });
		assert.deepEqual(data.tags, { data: null, error });
		assert.deepEqual(data.releaseDate, { data: null, error });
		assert.deepEqual(data.tracks, { data: null, error });
		assert.deepEqual(data.album, { data: null }, 'album is not wanted for an album URL');
		assert.deepEqual(data.imageUrl, { data: null, error });
		assert.equal(data.errors.length, 5);
		assert.ok(data.errors.every(x => x === error));
	});

	it('reports a supporters error only for the accounts', () => {
		const accountsError = new Error('supporters failed');
		const data = buildItemPageData(albumUrl, raw({ accountsError }), null);

		assert.deepEqual(data.accounts, { data: null, error: accountsError });
		assert.deepEqual(data.errors, [accountsError]);
		assert.deepEqual(data.tags.data, ['techno', 'house']);
	});
});

const tab = (count: number, token: string | null) => ({ item_count: count, last_token: token });

const emptyBlob = () => ({
	fan_data: { fan_id: 7 },
	collection_data: tab(0, null),
	wishlist_data: tab(0, null),
	followers_data: tab(0, null),
	following_fans_data: tab(0, null),
	item_cache: {},
});

type Call = { endpoint: string, body: any };

/** A fake API: answers come from `answer`, every call is recorded. */
const fakeApi = (answer: (call: Call, index: number) => ApiAnswer) => {
	const calls: Call[] = [];
	const requestApi = async (endpoint: string, body: object): Promise<ApiAnswer> => {
		const call = { endpoint, body };
		calls.push(call);
		return answer(call, calls.length - 1);
	};
	return { calls, requestApi };
};

describe('buildAccountPageData', () => {
	const fanUrl = 'https://bandcamp.com/fan';

	it('keeps the API constants', () => {
		assert.equal(API_PAGE_SIZE, 20);
		assert.equal(API_PAGE_LIMIT, 200);
		assert.deepEqual(
			Object.fromEntries(Object.entries(TAB_SOURCES).map(([k, v]) => [k, [v.cacheKey, v.dataKey, v.endpoint, v.urlField]])),
			{
				[AccountTab.Collection]: ['collection', 'collection_data', 'collection_items', 'item_url'],
				[AccountTab.Wishlist]: ['wishlist', 'wishlist_data', 'wishlist_items', 'item_url'],
				[AccountTab.Followers]: ['followers', 'followers_data', 'followers', 'trackpipe_url'],
				[AccountTab.Following]: ['following_fans', 'following_fans_data', 'following_fans', 'trackpipe_url'],
			},
		);
	});

	it('gives empty tabs and makes no call when every tab is empty', async () => {
		const { calls, requestApi } = fakeApi(() => assert.fail('no call expected'));
		const data = await buildAccountPageData(fanUrl, emptyBlob(), requestApi);

		assert.deepEqual(data, {
			url: fanUrl,
			collection: { total: 0, urls: [] },
			wishlist: { total: 0, urls: [] },
			following: { total: 0, urls: [] },
			followers: { total: 0, urls: [] },
			errors: [],
		});
		assert.equal(calls.length, 0);
	});

	it('reads the embedded batch and walks the API until more_available is false', async () => {
		const blob = {
			...emptyBlob(),
			collection_data: tab(5, 't0'),
			item_cache: {
				collection: {
					a: { item_url: 'https://x.bandcamp.com/album/one?from=fan' },
					b: { item_url: 'https://bandcamp.com/not-an-item' },
					c: {},
				},
			},
		};
		const { calls, requestApi } = fakeApi((_call, i) => i === 0
			? { status: 200, body: { items: [{ item_url: 'https://x.bandcamp.com/track/two' }, { item_url: 'https://x.bandcamp.com/album/one' }], more_available: true, last_token: 't1' } }
			: { status: 200, body: { items: [{ item_url: 'https://y.bandcamp.com/album/three' }, { other: 1 }], more_available: false, last_token: 't2' } });

		const data = await buildAccountPageData(fanUrl, blob, requestApi);

		assert.deepEqual(data.collection, {
			total: 5,
			urls: ['https://x.bandcamp.com/album/one', 'https://x.bandcamp.com/track/two', 'https://y.bandcamp.com/album/three'],
		});
		assert.deepEqual(calls, [
			{ endpoint: 'collection_items', body: { fan_id: 7, older_than_token: 't0', count: 20 } },
			{ endpoint: 'collection_items', body: { fan_id: 7, older_than_token: 't1', count: 20 } },
		]);
		assert.deepEqual(data.errors, []);
	});

	it('stops when the token repeats or is missing', async () => {
		const blob = { ...emptyBlob(), wishlist_data: tab(9, 't0') };

		const repeat = fakeApi(() => ({ status: 200, body: { items: [], more_available: true, last_token: 't0' } }));
		await buildAccountPageData(fanUrl, blob, repeat.requestApi);
		assert.equal(repeat.calls.length, 1);

		const missing = fakeApi(() => ({ status: 200, body: { items: [], more_available: true } }));
		await buildAccountPageData(fanUrl, blob, missing.requestApi);
		assert.equal(missing.calls.length, 1);
	});

	it('stops after API_PAGE_LIMIT calls', async () => {
		const blob = { ...emptyBlob(), collection_data: tab(100_000, 't0') };
		const { calls, requestApi } = fakeApi((_call, i) => ({
			status: 200,
			body: { items: [{ item_url: `https://x.bandcamp.com/track/${i}` }], more_available: true, last_token: `t${i + 1}` },
		}));

		const data = await buildAccountPageData(fanUrl, blob, requestApi);

		assert.equal(calls.length, 200);
		assert.equal(data.collection.urls.length, 200);
		assert.equal(data.collection.total, 100_000);
	});

	it('reads follower tabs from "followeers" and keeps only account URLs', async () => {
		const blob = {
			...emptyBlob(),
			followers_data: tab(3, 'f0'),
			following_fans_data: tab(1, null),
			item_cache: {
				followers: { a: { trackpipe_url: 'https://bandcamp.com/one' } },
				following_fans: { a: { trackpipe_url: 'https://bandcamp.com/two?x=1' } },
			},
		};
		const { calls, requestApi } = fakeApi(() => ({
			status: 200,
			body: { followeers: [{ trackpipe_url: 'https://bandcamp.com/three' }, { trackpipe_url: 'https://band.bandcamp.com/album/x' }], more_available: false },
		}));

		const data = await buildAccountPageData(fanUrl, blob, requestApi);

		assert.deepEqual(data.followers, { total: 3, urls: ['https://bandcamp.com/one', 'https://bandcamp.com/three'] });
		assert.deepEqual(data.following, { total: 1, urls: ['https://bandcamp.com/two'] }, 'no token: only the embedded batch');
		assert.deepEqual(calls.map(x => x.endpoint), ['followers']);
	});

	it('makes no API call without a fan id', async () => {
		const blob = {
			...emptyBlob(),
			fan_data: {},
			collection_data: tab(2, 't0'),
			item_cache: { collection: { a: { item_url: 'https://x.bandcamp.com/album/one' } } },
		};
		const { calls, requestApi } = fakeApi(() => assert.fail('no call expected'));

		const data = await buildAccountPageData(fanUrl, blob, requestApi);

		assert.deepEqual(data.collection, { total: 2, urls: ['https://x.bandcamp.com/album/one'] });
		assert.equal(calls.length, 0);
	});

	it('reads the tabs in the order collection, wishlist, following, followers', async () => {
		const blob = {
			...emptyBlob(),
			collection_data: tab(1, 'c'),
			wishlist_data: tab(1, 'w'),
			followers_data: tab(1, 'f'),
			following_fans_data: tab(1, 'g'),
		};
		const { calls, requestApi } = fakeApi(() => ({ status: 200, body: { more_available: false } }));

		await buildAccountPageData(fanUrl, blob, requestApi);

		assert.deepEqual(calls.map(x => x.endpoint), ['collection_items', 'wishlist_items', 'following_fans', 'followers']);
	});

	it('fails the whole account when the API refuses a request', async () => {
		const blob = { ...emptyBlob(), collection_data: tab(1, 'c'), wishlist_data: tab(5, 'w') };
		const { requestApi } = fakeApi(call => call.endpoint === 'wishlist_items'
			? { status: 403 }
			: { status: 200, body: { more_available: false } });

		await assert.rejects(buildAccountPageData(fanUrl, blob, requestApi), {
			message: 'Fan collection API refused "wishlist_items" with status 403',
		});
	});

	it('turns an API 429 into RateLimitedError for the page URL', async () => {
		const blob = { ...emptyBlob(), collection_data: tab(5, 'c') };
		const { requestApi } = fakeApi(() => ({ status: 429, retryAfter: '12' }));

		await assert.rejects(buildAccountPageData(fanUrl, blob, requestApi), (e: unknown) => {
			assert.ok(e instanceof RateLimitedError);
			assert.equal(e.url, fanUrl);
			assert.equal(e.retryAfter, '12');
			return true;
		});
	});

	it('keeps any other error inside the tab and reads the other tabs', async () => {
		const blob = { ...emptyBlob(), collection_data: tab(5, 'c'), wishlist_data: tab(1, null), item_cache: { wishlist: { a: { item_url: 'https://x.bandcamp.com/album/w' } } } };
		const boom = new Error('network down');
		const { requestApi } = fakeApi(() => { throw boom; });

		const data = await buildAccountPageData(fanUrl, blob, requestApi);

		assert.deepEqual(data.collection, { total: 0, urls: [], error: boom });
		assert.deepEqual(data.wishlist, { total: 1, urls: ['https://x.bandcamp.com/album/w'] });
		assert.deepEqual(data.errors, [boom]);
	});
});
