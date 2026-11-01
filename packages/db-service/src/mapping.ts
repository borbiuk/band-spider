import type {
	AccountPageDataDto,
	CrawlTaskDto,
	ItemPageDataDto,
} from '@band-spider/contracts';
import {
	AccountPageData,
	AccountTabData,
	CrawlTask,
	ItemPageData,
	ItemTabData,
	UrlType,
} from '@band-spider/core';

// The wire has message strings, the core code has Error objects. These functions turn one into the other.

const toError = (message: string | undefined): Error | undefined =>
	message === undefined ? undefined : new Error(message);

export const toCrawlTask = (task: CrawlTaskDto): CrawlTask => ({
	id: task.id,
	url: task.url,
	type: task.type as UrlType,
	...(task.marks ? { marks: task.marks } : {}),
});

export const toCrawlTaskDto = (task: CrawlTask): CrawlTaskDto => ({
	id: task.id,
	url: task.url,
	type: task.type,
	...(task.marks ? { marks: task.marks } : {}),
});

const accountTab = (tab: AccountPageDataDto['collection']): AccountTabData => ({
	total: tab.total,
	urls: tab.urls,
	complete: tab.complete,
	...(tab.stoppedAtMark !== undefined ? { stoppedAtMark: tab.stoppedAtMark } : {}),
	...(tab.error !== undefined ? { error: toError(tab.error) } : {}),
});

export const toAccountPageData = (data: AccountPageDataDto): AccountPageData => ({
	url: data.url,
	collection: accountTab(data.collection),
	wishlist: accountTab(data.wishlist),
	followers: accountTab(data.followers),
	following: accountTab(data.following),
	errors: data.errors.map(message => new Error(message)),
});

// a missing `data` is read as null: the contract does not force the key
const itemTab = <T>(tab: { data?: T, error?: string }): ItemTabData<T> => ({
	data: tab.data ?? null,
	...(tab.error !== undefined ? { error: toError(tab.error) } : {}),
});

export const toItemPageData = (data: ItemPageDataDto): ItemPageData => ({
	url: data.url,
	accounts: itemTab(data.accounts),
	tags: itemTab(data.tags),
	releaseDate: itemTab(data.releaseDate),
	...(data.album ? { album: itemTab(data.album) } : {}),
	...(data.tracks ? { tracks: itemTab(data.tracks) } : {}),
	imageUrl: itemTab(data.imageUrl),
	errors: data.errors.map(message => new Error(message)),
});
