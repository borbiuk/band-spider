import { LogSource } from './logger';

export const delay = async (timeout: number = 300) => 	await new Promise(resolve => setTimeout(resolve, timeout));
export const onlyUnique = <T>(value: T, index: number, array: T[]): boolean => array.indexOf(value) === index
export const isNullOrUndefined = (x: unknown): boolean => x === null || x === undefined;
export const isEmptyString = (x: string): boolean => isNullOrUndefined(x) || x === '';
export const isAlbumUrl = (url: string): boolean => isValidUrl(url) && url.includes('/album/');
export const isTrackUrl = (url: string): boolean => isValidUrl(url) && url.includes('/track/');
export const isItemUrl = (url: string): boolean => isValidUrl(url) && (url.includes('/album/') || url.includes('/track/'));
export const isAccountUrl = (url: string): boolean => isValidUrl(url) && url.includes('bandcamp.com') && !(url.includes('/album/') || url.includes('/track/'));
export const originalUrl = (url: string): string => isEmptyString(url) ? null : url.split('?')[0];
export const isValidDate = (date: Date): boolean => !isNullOrUndefined(date) && !isNaN(date.getTime());
export const isValidUrl = (urlString: string): boolean => {
	if (isEmptyString(urlString)) {
		return false;
	}

	try {
		return Boolean(new URL(urlString));
	} catch (e) {
		return false;
	}
}

export const waitOn = async (condition: () => boolean, timeout: number): Promise<boolean> => {
	const start: number = Date.now();

	while (Date.now() - start < timeout) {
		if (condition()) {
			return true;
		}
		await delay();
	}

	return false;
}

export const logMessage = (source: LogSource, message: string, url?: string): string => {
	return isEmptyString(url)
		? `\t${source} ${message}`
		: `\t${source} ${message} ▶ 🔗 ${url}`;
}
