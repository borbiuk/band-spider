import { accountColor, albumColor, dateColor, followerColor, itemColor, logger, LogSource, tagColor, urlColor } from './logger';

export const delay = async (timeout: number = 300) => await new Promise(resolve => setTimeout(resolve, timeout));
export const onlyUnique = <T>(value: T, index: number, array: T[]): boolean => array.indexOf(value) === index
export const isNullOrUndefined = (x: unknown): boolean => x === null || x === undefined;
export const isEmptyString = (x: string): boolean => isNullOrUndefined(x) || x.trim() === '';
export const isAlbumUrl = (url: string): boolean => isValidUrl(url) && url.includes('/album/');
export const isTrackUrl = (url: string): boolean => isValidUrl(url) && url.includes('/track/');
export const isItemUrl = (url: string): boolean => isValidUrl(url) && (url.includes('/album/') || url.includes('/track/'));
export const isAccountUrl = (url: string): boolean => isValidUrl(url) && url.startsWith('https://bandcamp.com/') && !(url.includes('/album/') || url.includes('/track/'));
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
		: `\t${source} ${message} 🔗 ${urlColor(url)}`;
}

const minus = (value: number): string => value === 0 ? '•' : String(value);
const yesNo = (value: boolean): string => value ? '+' : '•';

export const logAccountProcessed = (
	url: string,
	pageIndex: number,
	newItems: number,
	totalItems: number,
	allItemsRead: boolean,
	newWishlist: number,
	totalWishlist: number,
	allWishlistRead: boolean,
	newFollowers: number,
	totalFollowers: number,
	allFollowersRead: boolean,
	newFollowing: number,
	totalFollowing: number,
	allFollowingRead: boolean
) => {
	const itemsStat = itemColor(`${minus(newItems).padStart(4)}/${minus(totalItems).padEnd(4)}[${yesNo(allItemsRead)}]`);
	const wishlistItemsStat = itemColor(`${minus(newWishlist).padStart(4)}/${minus(totalWishlist).padEnd(4)}[${yesNo(allWishlistRead)}]`);
	const followersStat = followerColor(`${minus(newFollowers).padStart(4)}/${minus(totalFollowers).padEnd(4)}[${yesNo(allFollowersRead)}]`);
	const followingStat = followerColor(`${minus(newFollowing).padStart(4)}/${minus(totalFollowing).padEnd(4)}[${yesNo(allFollowingRead)}]`);

	const message = `[${String(pageIndex).padEnd(2)}] Account finished: ${itemsStat} ${wishlistItemsStat} ${followersStat} ${followingStat}`;

	logger.info(
		logMessage(LogSource.Account, message, url)
	);
}

export const logItemProcessed = (
	url: string,
	pageIndex: number,
	newAccounts: number,
	totalAccounts: number,
	albumInfo: { albumExtracted: boolean, albumRelationAlreadyExist: boolean },
	tracksInfo: { extractedTracksCount: number, newTracksCount: number },
	newTags: number,
	totalTags: number,
	releaseDateExtracted: boolean
) => {
	const accountsStat = accountColor(`${minus(newAccounts).padStart(3)}/${minus(totalAccounts).padEnd(3)}`);
	const albumStat = albumColor(isNullOrUndefined(albumInfo)
		? (isNullOrUndefined(tracksInfo)
			? '•'.padEnd(5)
			: `${minus(tracksInfo.newTracksCount).padStart(2)}/${minus(tracksInfo.extractedTracksCount).padEnd(2)}`)
		: yesNo(albumInfo.albumExtracted).padEnd(5)
	);
	const tagsStat = tagColor(`${minus(newTags).padStart(2)}/${minus(totalTags).padEnd(2)}`);
	const releaseDateStat = dateColor(yesNo(releaseDateExtracted));

	const message = `[${String(pageIndex).padEnd(2)}] ${accountsStat} ${albumStat} ${tagsStat} ${releaseDateStat}`;

	logger.info(
		logMessage(LogSource.Item, message, url)
	);
}
