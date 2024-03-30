export const onlyUnique = <T>(value: T, index: number, array: T[]): boolean => array.indexOf(value) === index
export const isNullOrUndefined = (x: unknown): boolean => x === null || x === undefined;
export const isEmptyString = (x: string): boolean => isNullOrUndefined(x) || x === '';
export const isAlbum = (url: string): boolean => url.includes('/album/');
export const isTrack = (url: string): boolean => url.includes('/track/');
export const originalUrl = (url: string): string => url.split('?')[0];
export const isValidUrl = (urlString: string): boolean => {
	if (isEmptyString(urlString)) {
		return false;
	}

	try {
		return Boolean(new URL(urlString));
	}
	catch(e){
		return false;
	}
}
