import type {
	AccountPageDataDto,
	CrawlTaskDto,
	ItemPageDataDto,
} from '@band-spider/contracts';
import {
	AccountPageData,
	AccountTabData,
	CrawlTask,
	errorMessage,
	ItemPageData,
	ItemTabData,
	UrlType,
} from '@band-spider/core';

// The core code has Error objects, the wire has message strings. These functions turn one into the other.
// A Date needs no mapping: JSON writes it as an ISO string.

export const toCrawlTaskDto = (task: CrawlTask): CrawlTaskDto => ({
	id: task.id,
	url: task.url,
	type: task.type,
	...(task.marks ? { marks: task.marks } : {}),
});

export const toCrawlTask = (task: CrawlTaskDto): CrawlTask => ({
	id: task.id,
	url: task.url,
	type: task.type as UrlType,
	...(task.marks ? { marks: task.marks } : {}),
});

const accountTabDto = (tab: AccountTabData): AccountPageDataDto['collection'] => ({
	total: tab.total,
	urls: tab.urls,
	complete: tab.complete,
	...(tab.stoppedAtMark !== undefined ? { stoppedAtMark: tab.stoppedAtMark } : {}),
	...(tab.error !== undefined ? { error: errorMessage(tab.error) } : {}),
});

export const toAccountPageDataDto = (data: AccountPageData): AccountPageDataDto => ({
	url: data.url,
	collection: accountTabDto(data.collection),
	wishlist: accountTabDto(data.wishlist),
	followers: accountTabDto(data.followers),
	following: accountTabDto(data.following),
	errors: data.errors.map(errorMessage),
});

// `data` is always written (null when empty): the contract needs the key
const itemTabDto = <T>(tab: ItemTabData<T>): { data: T | null, error?: string } => ({
	data: tab.data ?? null,
	...(tab.error !== undefined ? { error: errorMessage(tab.error) } : {}),
});

export const toItemPageDataDto = (data: ItemPageData): ItemPageDataDto => ({
	url: data.url,
	accounts: itemTabDto(data.accounts),
	tags: itemTabDto(data.tags),
	releaseDate: itemTabDto(data.releaseDate),
	...(data.album ? { album: itemTabDto(data.album) } : {}),
	...(data.tracks ? { tracks: itemTabDto(data.tracks) } : {}),
	imageUrl: itemTabDto(data.imageUrl),
	errors: data.errors.map(errorMessage),
});
