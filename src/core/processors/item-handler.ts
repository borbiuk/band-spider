import { Page } from 'puppeteer';
import { logger, LogSource } from '../../common/logger';
import { QueueEvent } from '../../common/processing-queue';
import { isAlbumUrl, isNullOrUndefined, isTrackUrl, logMessage } from '../../common/utils';
import { BandDatabase } from '../../data/db';
import { ItemPageService } from '../page-services/item-page-service';

export class ItemHandler {
	private readonly pageService: ItemPageService = new ItemPageService();
	private database: BandDatabase;

	constructor(
		private readonly page: Page
	) {
	}

	public async processItem(
		{ id, url }: QueueEvent
	): Promise<string[]> {
		logger.info(
			logMessage(
				LogSource.Item,
				`Start processing:`,
				url
			)
		);

		this.database = await BandDatabase.initialize();

		const urls: string[] = [];

		// open Item url
		await this.page.goto(url, { timeout: 60_000, waitUntil: 'networkidle0' });

		// save Item release date
		const releaseDateProcessingResult = await this.readAndSaveReleaseDate(id);

		// scrap and save Tags
		const tagsProcessingResult = await this.readAndSaveTags(id);

		// scrap and save Accounts
		const accountsProcessingResult = await this.readAndSaveAccounts(id, urls);

		// extract album or tracks
		let albumInfo: object = null;
		if (isAlbumUrl(url)) {
			albumInfo = await this.readAndSaveAlbumTracks(url, urls);
		} else if (isTrackUrl(url)) {
			albumInfo = await this.readAndSaveTrackAlbum(url, urls);
		}

		// save that item was processed now
		await this.database.item.updateProcessingDate(id);

		logger.info(
			logMessage(
				LogSource.Item,
				`Processing finished: ${JSON.stringify({ ...releaseDateProcessingResult, ...accountsProcessingResult, ...tagsProcessingResult, ...albumInfo })}`,
				url
			)
		);

		return urls;
	}

	private async readAndSaveReleaseDate(
		itemId: number
	): Promise<{ isDateExtracted: boolean, isDateAlreadySaved: boolean }> {
		let isDateExtracted: boolean = false;
		let isDateAlreadySaved: boolean = false;

		const url: string = this.page.url();
		try {
			const date: Date = await this.pageService.readTrackReleaseDate(this.page);
			if (!isNullOrUndefined(date)) {
				isDateExtracted = true;
				isDateAlreadySaved = !await this.database.item.updateReleaseDate(itemId, date);
			}
		} catch (error) {
			logger.error(error, logMessage(LogSource.Date, `Processing failed: ${error.message}`, url));
		}

		return { isDateExtracted, isDateAlreadySaved };
	}

	private async readAndSaveTags(
		itemId: number
	): Promise<{ totalTagsCount: number, newTagsCount: number }> {
		let totalTagsCount: number = 0;
		let newTagsCount: number = 0;

		const url: string = this.page.url();
		try {
			const tags: string[] = await this.pageService.readAllPageTags(this.page);
			totalTagsCount = tags.length;

			// save Tags
			const tagsIds: number[] = [];
			for (const tag of tags) {
				const { id } = await this.database.tag.insert(tag);
				tagsIds.push(id);
			}

			// save Tags relations
			for (const tagId of tagsIds) {
				const added = await this.database.tag.addItem(tagId, itemId);
				if (added) {
					newTagsCount++;
				}
			}
		} catch (error) {
			logger.error(error, logMessage(LogSource.Tag, `Processing failed: ${error.message}`, url));
		}

		return { totalTagsCount, newTagsCount };
	}

	private async readAndSaveAccounts(
		itemId: number,
		urls: string[]
	): Promise<{ totalAccountsCount: number, newAccountCount: number }> {
		let totalAccountsCount: number = 0;
		let newAccountCount: number = 0;

		const url: string = this.page.url();
		try {
			const accounts: string[] = await this.pageService.readAllPageAccounts(this.page);
			totalAccountsCount = accounts.length;

			// save Accounts
			const accountsIds: number[] = [];

			for (const accountUrl of accounts) {
				const { id, url } = await this.database.account.insert(accountUrl);
				if (id === 0) {
					continue;
				}
				accountsIds.push(id);

				// add to processing
				urls.push(url);
			}

			// save Accounts relations
			for (const accountId of accountsIds) {
				const added = await this.database.account.addItem(accountId, itemId);
				if (added) {
					newAccountCount++;
				}
			}
		} catch (error) {
			logger.error(error, logMessage(LogSource.Item, `Accounts processing failed: ${error.message}`, url));
		}

		return { totalAccountsCount, newAccountCount };
	}

	private async readAndSaveAlbumTracks(
		albumUrl: string,
		urls: string[]
	): Promise<{extractedTracksCount: number, albumRelationAlreadyExist: number}> {

		const url: string = this.page.url();
		try {
			const tracksUrls: string[] = await this.pageService.readAllAlbumTracks(this.page);

			let albumRelationAlreadyExist: number = 0;
			const album = await this.database.item.insert(albumUrl);
			for (const trackUrl of tracksUrls) {
				if (!await this.database.item.insertTrackToAlbum(trackUrl, album)) {
					albumRelationAlreadyExist++;
				}

				// add to processing
				urls.push(trackUrl);
			}

			return { extractedTracksCount: tracksUrls.length, albumRelationAlreadyExist }
		} catch (error) {
			logger.error(error, logMessage(LogSource.Item, `Album Tracks processing failed: ${error.message}`, url));
		}

		return null;
	}

	private async readAndSaveTrackAlbum(
		trackUrl: string,
		urls: string[]
	): Promise<{ albumExtracted: boolean, albumRelationAlreadyExist: boolean }> {
		const url: string = this.page.url();
		try {
			const albumUrl: string = await this.pageService.readTrackAlbum(this.page);
			const album = await this.database.item.insert(albumUrl);
			if (!isNullOrUndefined(albumUrl)) {
				const added = await this.database.item.insertTrackToAlbum(trackUrl, album);

				// add to processing
				urls.push(albumUrl);

				return { albumExtracted: true, albumRelationAlreadyExist: !added };
			}
		} catch (error) {
			logger.error(error, logMessage(LogSource.Item, `Track Album processing failed: ${error.message}`, url));
		}

		return null;
	}
}
