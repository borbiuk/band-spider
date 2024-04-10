import { Page } from 'puppeteer';
import { logger, Source } from '../../common/logger';
import { isAlbum, isNullOrUndefined, isTrack, logMessage } from '../../common/utils';
import { Database } from '../../data/db';
import { ItemPageService } from '../page-services/item-page-service';

export class ItemHandler {
	private readonly pageService: ItemPageService = new ItemPageService();
	private database: Database;

	public async processItem(
		page: Page,
		itemUrl: string
	): Promise<string[]> {
		if (isNullOrUndefined(this.database)) {
			this.database = await Database.initialize();
		}

		const urls: string[] = [];

		// open Item url
		await page.goto(itemUrl, { timeout: 30_000, waitUntil: 'domcontentloaded' });

		// save Item
		const { id } = await this.database.insertItem(itemUrl);

		// save Item release date
		const releaseDateProcessingResult = await this.readAndSaveReleaseDate(page, id);

		// scrap and save Tags
		const tagsProcessingResult = await this.readAndSaveTags(page, id);

		// scrap and save Accounts
		const accountsProcessingResult = await this.readAndSaveAccounts(page, id, urls);

		// extract album or tracks
		let albumInfo: object = null;
		if (isAlbum(itemUrl)) {
			albumInfo = await this.readAndSaveAlbumTracks(page, itemUrl, urls);
		} else if (isTrack(itemUrl)) {
			albumInfo = await this.readAndSaveTrackAlbum(page, itemUrl, urls);
		}

		// save that item was processed now
		await this.database.updateItemProcessingDate(id);

		logger.info(
			logMessage(
				Source.Item,
				`Processing finished: ${JSON.stringify({ ...releaseDateProcessingResult, ...accountsProcessingResult, ...tagsProcessingResult, ...albumInfo })}`,
				itemUrl
			)
		);

		return urls;
	}

	private async readAndSaveReleaseDate(
		page: Page,
		itemId: number
	): Promise<{ isDateExtracted: boolean, isDateAlreadySaved: boolean }> {
		let isDateExtracted: boolean = false;
		let isDateAlreadySaved: boolean = false;

		const url: string = page.url();
		try {
			const date: Date = await this.pageService.readTrackReleaseDate(page);
			if (!isNullOrUndefined(date)) {
				isDateExtracted = true;
				isDateAlreadySaved = !await this.database.updateItemReleaseDate(itemId, date);
			}
		} catch (error) {
			logger.error(error, logMessage(Source.Date, `Processing failed: ${error.message}`, url));
		}

		return { isDateExtracted, isDateAlreadySaved };
	}

	private async readAndSaveTags(
		page: Page,
		itemId: number
	): Promise<{ totalTagsCount: number, newTagsCount: number }> {
		let totalTagsCount: number = 0;
		let newTagsCount: number = 0;

		const url: string = page.url();
		try {
			const tags: string[] = await this.pageService.readAllPageTags(page);
			totalTagsCount = tags.length;

			// save Tags
			const tagsIds: number[] = [];
			for (const tag of tags) {
				const { id } = await this.database.insertTag(tag);
				tagsIds.push(id);
			}

			// save Tags relations
			for (const tagId of tagsIds) {
				const added = await this.database.insertItemToTag(itemId, tagId);
				if (added) {
					newTagsCount++;
				}
			}
		} catch (error) {
			logger.error(error, logMessage(Source.Tag, `Processing failed: ${error.message}`, url));
		}

		return { totalTagsCount, newTagsCount };
	}

	private async readAndSaveAccounts(
		page: Page,
		itemId: number,
		urls: string[]
	): Promise<{ totalAccountsCount: number, newAccountCount: number }> {
		let totalAccountsCount: number = 0;
		let newAccountCount: number = 0;

		const url: string = page.url();
		try {
			const accounts: string[] = await this.pageService.readAllPageAccounts(page);
			totalAccountsCount = accounts.length;

			// save Accounts
			const accountsIds: number[] = [];

			for (const accountUrl of accounts) {
				const { id, url } = await this.database.insertAccount(accountUrl);
				if (id === 0) {
					continue;
				}
				accountsIds.push(id);

				// add to processing
				urls.push(url);
			}

			// save Accounts relations
			for (const accountId of accountsIds) {
				const added = await this.database.insertItemToAccount(itemId, accountId);
				if (added) {
					newAccountCount++;
				}
			}
		} catch (error) {
			logger.error(error, logMessage(Source.Item, `Accounts processing failed: ${error.message}`, url));
		}

		return { totalAccountsCount, newAccountCount };
	}

	private async readAndSaveAlbumTracks(
		page: Page,
		albumUrl: string,
		urls: string[]
	): Promise<{extractedTracksCount: number, albumRelationAlreadyExist: number}> {

		const url: string = page.url();
		try {
			const tracksUrls: string[] = await this.pageService.readAllAlbumTracks(page);

			let albumRelationAlreadyExist: number = 0;
			for (const trackUrl of tracksUrls) {
				if (!await this.database.insertTrackToAlbum(trackUrl, albumUrl)) {
					albumRelationAlreadyExist++;
				}

				// add to processing
				urls.push(trackUrl);
			}

			return { extractedTracksCount: tracksUrls.length, albumRelationAlreadyExist }
		} catch (error) {
			logger.error(error, logMessage(Source.Item, `Album Tracks processing failed: ${error.message}`, url));
		}

		return null;
	}

	private async readAndSaveTrackAlbum(
		page: Page,
		trackUrl: string,
		urls: string[]
	): Promise<{ albumExtracted: boolean, albumRelationAlreadyExist: boolean }> {
		const url: string = page.url();
		try {
			const albumUrl: string = await this.pageService.readTrackAlbum(page);
			if (!isNullOrUndefined(albumUrl)) {
				const added = await this.database.insertTrackToAlbum(trackUrl, albumUrl);

				// add to processing
				urls.push(albumUrl);

				return { albumExtracted: true, albumRelationAlreadyExist: !added };
			}
		} catch (error) {
			logger.error(error, logMessage(Source.Item, `Track Album processing failed: ${error.message}`, url));
		}

		return null;
	}
}
