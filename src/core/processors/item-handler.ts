import { Page } from 'puppeteer';
import { logger } from '../../common/logger';
import { isAlbum, isNullOrUndefined, isTrack } from '../../common/utils';
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
		await page.goto(itemUrl, { timeout: 10_000, waitUntil: 'networkidle0' });

		// save Item
		const { id } = await database.insertItem(itemUrl);

		// scrap and save Tags
		const tagsCount: number = await this.readAndSaveTags(page, pageService, database, id);

		// scrap and save Accounts
		const accountsCount: number = await this.readAndSaveAccount(page, pageService, database, id, urls);

		// extract album or tracks
		let albumInfo = null;
		if (isAlbum(itemUrl)) {
			const albumLength: number = await this.readAndSaveAlbumTracks(page, pageService, database, itemUrl, urls);
			albumInfo = {
				albumLength
			};
		} else if (isTrack(itemUrl)) {
			const albumExtracted: boolean = await this.readAndSaveTrackAlbum(page, pageService, database, itemUrl, urls);
			albumInfo = {
				albumExtracted
			};
		}

		logger.info({
			message: 'Item processing finished!',
			url: itemUrl,
			accounts: accountsCount,
			tags: tagsCount,
			...albumInfo
		});

		return urls;
	}

	private async readAndSaveTags(page: Page, service: ItemPageService, database: Database, itemId: number): Promise<number> {
		let tagRelationsCount = 0;
		try {
			const tags: string[] = await service.readAllPageTags(page);

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
					tagRelationsCount++;
				}
			}
		} catch (error) {
			logger.error(error, '[Item] Tags processing failed!')
		}

		return tagRelationsCount;
	}

	private async readAndSaveAccount(page: Page, service: ItemPageService, database: Database, itemId: number, urls: string[]): Promise<number> {
		let accountsRelationsCount: number = 0;
		try {
			const accounts: string[] = await service.readAllPageAccounts(page);

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
					accountsRelationsCount++;
				}
			}
		} catch (error) {
			logger.error(error, '[Item] Accounts processing failed!')
		}

		return accountsRelationsCount;
	}

	private async readAndSaveAlbumTracks(
		page: Page,
		pageService: ItemPageService,
		database: Database,
		albumUrl: string,
		urls: string[]
	): Promise<number> {
		let trackAlbumRelationsCount: number = 0;

		try {
			const tracksUrls: string[] = await pageService.readAllAlbumTracks(page);
			while (tracksUrls.length > 0) {
				const trackUrl = tracksUrls.pop();
				const added = await database.insertTrackToAlbum(trackUrl, albumUrl);
				if (added) {
					trackAlbumRelationsCount++;
				}

				// add to processing
				urls.push(trackUrl);
			}
		}
		catch (error) {
			logger.error(error, '[Item] Album Tracks processing failed!');
		}

		return trackAlbumRelationsCount;
	}

	private async readAndSaveTrackAlbum(
		page: Page,
		pageService: ItemPageService,
		database: Database,
		trackUrl: string,
		urls: string[]
	): Promise<boolean> {
		try {
			const albumUrl: string = await pageService.readTrackAlbum(page);
			if (!isNullOrUndefined(albumUrl)) {
				const added = await database.insertTrackToAlbum(trackUrl, albumUrl);

				// add to processing
				urls.push(albumUrl);

				return added;
			}
		}
		catch (error) {
			logger.error(error, '[Item] Track Album processing failed');
		}

		return false;
	}
}
