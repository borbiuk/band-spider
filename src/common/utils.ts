import { UrlScrapResult } from '../models/url-scrap-result';

export const onlyUnique = <T>(value: T, index: number, array: T[]): boolean => {
	return array.indexOf(value) === index;
}

export const onlyUniqueScrapResult = (value: UrlScrapResult, index: number, array: UrlScrapResult[]): boolean => {
	return array.findIndex(x => x.url === value.url) === index;
}

export const divideArray = <T>(array: T[], length: number): T[][] => {
	const dividedArray: T[][] = [];
	for (let i = 0; i < array.length; i += length) {
		dividedArray.push(array.slice(i, i + length));
	}
	return dividedArray;
}

export const delay = (time: number): Promise<void> => {
	return new Promise(function (resolve) {
		setTimeout(resolve, time)
	});
}

export const isArray = (value: unknown): value is [] => Array.isArray(value);
export const isObject = (value: unknown): value is object => typeof value === 'object';
export const isNullOrUndefined = (x: unknown): boolean => x === null || x === undefined;
export const isEmptyString = (x: string): boolean => isNullOrUndefined(x) || x === '';
export const isAlbum = (url: string): boolean => url.includes('/album/');
export const isTrack = (url: string): boolean => url.includes('/track/');
export const originalUrl = (url): string => url.split('?')[0];
