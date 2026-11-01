import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	chunk,
	isAccountUrl,
	isAlbumUrl,
	isEmptyString,
	isItemUrl,
	isNullOrUndefined,
	isTrackUrl,
	isValidDate,
	isValidUrl,
	onlyUnique,
	originalUrl,
} from '../common/utils';

describe('URL predicates', () => {
	// [url, isValidUrl, isItemUrl, isAlbumUrl, isTrackUrl, isAccountUrl]
	const table: [string, boolean, boolean, boolean, boolean, boolean][] = [
		['https://band.bandcamp.com/album/one', true, true, true, false, false],
		['https://band.bandcamp.com/track/one', true, true, false, true, false],
		['https://bandcamp.com/fan', true, false, false, false, true],
		['https://bandcamp.com/fan?from=x', true, false, false, false, true],
		['https://bandcamp.com/album/x', true, true, true, false, false],
		['http://bandcamp.com/fan', true, false, false, false, false],
		['https://band.bandcamp.com/', true, false, false, false, false],
		['https://example.com/track/x', true, true, false, true, false],
		['band.bandcamp.com/album/one', false, false, false, false, false],
		['', false, false, false, false, false],
		['   ', false, false, false, false, false],
	];

	for (const [url, valid, item, album, track, account] of table) {
		it(`classifies "${url}"`, () => {
			assert.equal(isValidUrl(url), valid, 'isValidUrl');
			assert.equal(isItemUrl(url), item, 'isItemUrl');
			assert.equal(isAlbumUrl(url), album, 'isAlbumUrl');
			assert.equal(isTrackUrl(url), track, 'isTrackUrl');
			assert.equal(isAccountUrl(url), account, 'isAccountUrl');
		});
	}

	it('treats null and undefined as invalid', () => {
		assert.equal(isValidUrl(null), false);
		assert.equal(isValidUrl(undefined), false);
		assert.equal(isItemUrl(null), false);
		assert.equal(isAccountUrl(undefined), false);
	});
});

describe('originalUrl', () => {
	it('drops the query string', () => {
		assert.equal(originalUrl('https://bandcamp.com/fan?from=a&b=c'), 'https://bandcamp.com/fan');
	});

	it('keeps a URL without a query string and keeps the hash', () => {
		assert.equal(originalUrl('https://bandcamp.com/fan'), 'https://bandcamp.com/fan');
		assert.equal(originalUrl('https://bandcamp.com/fan#x'), 'https://bandcamp.com/fan#x');
	});

	it('returns null for empty input', () => {
		assert.equal(originalUrl(''), null);
		assert.equal(originalUrl('  '), null);
		assert.equal(originalUrl(null), null);
		assert.equal(originalUrl(undefined), null);
	});
});

describe('small helpers', () => {
	it('chunk splits into parts of the given size', () => {
		assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
		assert.deepEqual(chunk([], 2), []);
		assert.deepEqual(chunk([1, 2], 500), [[1, 2]]);
	});

	it('onlyUnique keeps the first of each value', () => {
		assert.deepEqual(['a', 'b', 'a', 'c', 'b'].filter(onlyUnique), ['a', 'b', 'c']);
	});

	it('isNullOrUndefined and isEmptyString', () => {
		assert.equal(isNullOrUndefined(null), true);
		assert.equal(isNullOrUndefined(undefined), true);
		assert.equal(isNullOrUndefined(0), false);
		assert.equal(isNullOrUndefined(''), false);
		assert.equal(isEmptyString(''), true);
		assert.equal(isEmptyString(' \t'), true);
		assert.equal(isEmptyString(null), true);
		assert.equal(isEmptyString('a'), false);
	});

	it('isValidDate', () => {
		assert.equal(isValidDate(new Date('2024-01-02')), true);
		assert.equal(isValidDate(new Date('nope')), false);
		assert.equal(isValidDate(null), false);
	});
});
