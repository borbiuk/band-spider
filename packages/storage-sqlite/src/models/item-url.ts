/** The kind of an item. The values are stored in `items.type`. */
export enum ItemType {
	Track = 0,
	Album = 1,
}

/** The type of an item URL; undefined when the URL is not a track or an album (an artist page, `/subscribe` and so on). */
export function itemTypeOf(url: string): ItemType | undefined {
	if (url.includes('/track/')) {
		return ItemType.Track;
	}
	if (url.includes('/album/')) {
		return ItemType.Album;
	}
	return undefined;
}

/** An item URL as it is stored. */
export const normalizeItemUrl = (url: string): string => url.trim();

/** An account URL as it is stored: Bandcamp fan URLs do not depend on case. */
export const normalizeAccountUrl = (url: string): string => url.trim().toLowerCase();

/** Whether the URL is stored as an item. Other URLs are dropped before they are saved. */
export const isItemUrl = (url: string): boolean => itemTypeOf(normalizeItemUrl(url)) !== undefined;
