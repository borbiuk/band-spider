export const onlyUnique = <T>(value: T, index: number, array: T[]): boolean => {
	return array.indexOf(value) === index;
}

export const createChunks = <T>(array: T[], chunkCount: number): T[][] => {
	const length = array.length;
	const chunkSize = Math.ceil(length / chunkCount);
	const chunks: T[][] = [];

	for (let i = 0; i < length; i += chunkSize) {
		const chunk = array.slice(i, i + chunkSize);
		chunks.push(chunk);
	}

	return chunks;
}

export const divideArray = <T>(array: T[], length: number): T[][] => {
	const dividedArray: T[][] = [];
	for (let i = 0; i < array.length; i += length) {
		dividedArray.push(array.slice(i, i + length));
	}
	return dividedArray;
}

export const delay = (time): Promise<void> => {
	return new Promise(function (resolve) {
		setTimeout(resolve, time)
	});
}

export const isArray = (value): value is [] => Array.isArray(value);
export const isObject = (value): value is object => typeof value === 'object';
export const isNullOrUndefined = (x): boolean => x === null || x === undefined;
export const isEmptyString = (x: string): boolean => isNullOrUndefined(x) || x === '';
export const isAlbum = (url): boolean => url.includes('/album/');
export const isTrack = (url): boolean => url.includes('/track/');
export const originalUrl = (url): string => url.split('?')[0];
