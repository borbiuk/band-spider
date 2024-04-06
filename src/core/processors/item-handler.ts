import { Page } from 'puppeteer';
import { logger, Source } from '../../common/logger';
import { isAlbum, isNullOrUndefined, isTrack, logMessage } from '../../common/utils';
import { Database } from '../../data/db';
import { ItemPageService } from '../page-services/item-page-service';

export class ItemHandler {
	public async processItem(
		page: Page,
		pageService: ItemPageService,
		database: Database,
		itemUrl: string
	): Promise<string[]> {
		const urls: string[] = [];

		// open Item url
		await page.goto(itemUrl, { timeout: 15_000, waitUntil: 'domcontentloaded' });

		// save Item
		const { id } = await database.insertItem(itemUrl);

		// scrap and save Tags
		const tagsProcessingResult = await this.readAndSaveTags(page, pageService, database, id);

		// scrap and save Accounts
		const accountsProcessingResult = await this.readAndSaveAccounts(page, pageService, database, id, urls);

		// extract album or tracks
		let albumInfo: object = null;
		if (isAlbum(itemUrl)) {
			albumInfo = await this.readAndSaveAlbumTracks(page, pageService, database, itemUrl, urls);
		} else if (isTrack(itemUrl)) {
			albumInfo =  await this.readAndSaveTrackAlbum(page, pageService, database, itemUrl, urls);
		}

		logger.info(
			logMessage(
				Source.Item,
				`Processing finished: ${JSON.stringify({...accountsProcessingResult, ...tagsProcessingResult, ...albumInfo})}`,
				itemUrl
			)
		);

		return urls;
	}

	private async readAndSaveTags(
		page: Page,
		service: ItemPageService,
		database: Database,
		itemId: number
	): Promise<{ totalTagsCount: number, newTagsCount: number }> {
		let totalTagsCount: number = 0;
		let newTagsCount: number = 0;

		const url: string = page.url();
		try {
			const tags: string[] = await service.readAllPageTags(page);
			totalTagsCount = tags.length;

			// save Tags
			const tagsIds: number[] = [];
			for (const tag of tags) {
				const { id } = await database.insertTag(tag);
				tagsIds.push(id);
			}

			// save Tags relations
			for (const tagId of tagsIds) {
				const added = await database.insertItemToTag(itemId, tagId);
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
		service: ItemPageService,
		database: Database,
		itemId: number,
		urls: string[]
	): Promise<{ totalAccountsCount: number, newAccountCount: number }> {
		let totalAccountsCount: number = 0;
		let newAccountCount: number = 0;

		const url: string = page.url();
		try {
			const accounts: string[] = await service.readAllPageAccounts(page);
			totalAccountsCount = accounts.length;

			// save Accounts
			const accountsIds: number[] = [];

			for (const accountUrl of accounts) {
				const { id, url } = await database.insertAccount(accountUrl);
				accountsIds.push(id);

				// add to processing
				urls.push(url);
			}

			// save Accounts relations
			for (const accountId of accountsIds) {
				const added = await database.insertItemToAccount(itemId, accountId);
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
		pageService: ItemPageService,
		database: Database,
		albumUrl: string,
		urls: string[]
	): Promise<{  }> {

		const url: string = page.url();
		try {
			const tracksUrls: string[] = await pageService.readAllAlbumTracks(page);

			let albumRelationAlreadyExist: number = 0;
			while (tracksUrls.length > 0) {
				const trackUrl = tracksUrls.pop();
				const added = await database.insertTrackToAlbum(trackUrl, albumUrl);
				if (added) {
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
		pageService: ItemPageService,
		database: Database,
		trackUrl: string,
		urls: string[]
	): Promise<{ albumExtracted: boolean, albumRelationAlreadyExist: boolean }> {
		const url: string = page.url();
		try {
			const albumUrl: string = await pageService.readTrackAlbum(page);
			if (!isNullOrUndefined(albumUrl)) {
				const added = await database.insertTrackToAlbum(trackUrl, albumUrl);

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
