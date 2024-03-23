export const onlyUnique = <T>(value: T, index: number, array: T[]): boolean => {
	return array.indexOf(value) === index;
}

export const delay = (ms: number): Promise<void> => {
	return new Promise(function (resolve) {
		setTimeout(resolve, ms)
	});
}

export const isNullOrUndefined = (x: unknown): boolean => x === null || x === undefined;
export const isEmptyString = (x: string): boolean => isNullOrUndefined(x) || x === '';
export const isAlbum = (url: string): boolean => url.includes('/album/');
export const isTrack = (url: string): boolean => url.includes('/track/');
export const originalUrl = (url): string => url.split('?')[0];
