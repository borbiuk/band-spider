import { Page } from 'puppeteer';
import { logger, LogSource } from '../../common/logger';
import { QueueEvent } from '../../common/processing-queue';
import { isAlbumUrl, isNullOrUndefined, isTrackUrl, logItemProcessed, logMessage } from '../../common/utils';
import { BandDatabase } from '../../data/db';
import { ItemPageService } from '../page-services/item-page-service';
import { ProxyClient } from '../proxy/proxy-client';

export class ItemHandler {
	private readonly pageService: ItemPageService = new ItemPageService();
	private database: BandDatabase;

	constructor() {
	}

	public async processItem(
		page: Page,
		{ id, url }: QueueEvent,
		pageIndex: number,
		clearPageCache: () => Promise<void>
	): Promise<boolean> {
		this.database = await BandDatabase.initialize();

		// open Item url
		try {
			await page.goto(url, { timeout: 5_000, waitUntil: 'domcontentloaded' });
		} catch (error) {
			await clearPageCache();

			const proxyChanged = ProxyClient.initialize.changeIp();
			if (proxyChanged) {
				throw error;
			}

			logger.warn(logMessage(LogSource.Item, `[${pageIndex}]\tProcessing stopped`, url));
			return false;
		}

		// save Item release date
		const { extracted, alreadySaved } = await this.readAndSaveReleaseDate(page, id);

		// scrap and save Tags
		const { newTags, totalTags } = await this.readAndSaveTags(page, id);

		// scrap and save Accounts
		const { newAccounts, totalAccounts } = await this.readAndSaveAccounts(page, id);

		// extract album or tracks
		let tracksInfo = null;
		let albumInfo = null;
		if (isAlbumUrl(url)) {
			tracksInfo = await this.readAndSaveAlbumTracks(page, url);
		} else if (isTrackUrl(url)) {
			albumInfo = await this.readAndSaveTrackAlbum(page, url);
		}

		// save that item was processed now
		await this.database.item.updateProcessingDate(id);

		logItemProcessed(
			url,
			pageIndex,
			newAccounts,
			totalAccounts,
			albumInfo,
			tracksInfo,
			newTags,
			totalTags,
			extracted
		);

		// invalid handling of page
		if (totalTags === 0 && totalAccounts === 0 && !extracted && !alreadySaved) {
			ProxyClient.initialize.changeIp();
		}

		return true;
	}

	private async readAndSaveReleaseDate(
		page: Page,
		itemId: number
	): Promise<{ extracted: boolean, alreadySaved: boolean }> {
		let isDateExtracted: boolean = false;
		let isDateAlreadySaved: boolean = false;

		const url: string = page.url();
		try {
			const date: Date = await this.pageService.readTrackReleaseDate(page);
			if (!isNullOrUndefined(date)) {
				isDateExtracted = true;
				isDateAlreadySaved = !await this.database.item.updateReleaseDate(itemId, date);
			}
		} catch (error) {
			logger.error(error, logMessage(LogSource.Date, `Processing failed: ${error.message}`, url));
		}

		return { extracted: isDateExtracted, alreadySaved: isDateAlreadySaved };
	}

	private async readAndSaveTags(
		page: Page,
		itemId: number
	): Promise<{ totalTags: number, newTags: number }> {
		let totalTagsCount: number = 0;
		let newTagsCount: number = 0;

		const url: string = page.url();
		try {
			const tags: string[] = await this.pageService.readAllPageTags(page);
			totalTagsCount = tags.length;

			// save Tags
			const tagsIds: number[] = [];
			for (const tag of tags) {
				const { entity: {id}, isInserted } = await this.database.tag.insert(tag);
				tagsIds.push(id);

				if (isInserted) {
					newTagsCount++;
				}
			}

			// save Tags relations
			for (const tagId of tagsIds) {
				await this.database.tag.addItem(tagId, itemId);
			}
		} catch (error) {
			logger.error(error, logMessage(LogSource.Tag, `Processing failed: ${error.message}`, url));
		}

		return { totalTags: totalTagsCount, newTags: newTagsCount };
	}

	private async readAndSaveAccounts(
		page: Page,
		itemId: number
	): Promise<{ totalAccounts: number, newAccounts: number }> {
		let totalAccountsCount: number = 0;
		let newAccountCount: number = 0;
		let newRelationsCount: number = 0;

		const url: string = page.url();
		try {
			const accounts: string[] = await this.pageService.readAllPageAccounts(page);
			totalAccountsCount = accounts.length;

			// save Accounts
			const accountsIds: number[] = [];

			for (const accountUrl of accounts) {
				const { entity: { id }, isInserted } = await this.database.account.insert(accountUrl);
				accountsIds.push(id);
				if (isInserted) {
					newAccountCount++;
				}
			}

			// save Accounts relations
			for (const accountId of accountsIds) {
				const added = await this.database.account.addItem(accountId, itemId);
				if (added) {
					newRelationsCount++;
				}
			}
		} catch (error) {
			logger.error(error, logMessage(LogSource.Item, `Accounts processing failed: ${error.message}`, url));
		}

		return { totalAccounts: totalAccountsCount, newAccounts: newAccountCount };
	}

	private async readAndSaveAlbumTracks(
		page: Page,
		albumUrl: string
	): Promise<{ extractedTracksCount: number, newTracksCount: number }> {

		const url: string = page.url();
		try {
			const tracksUrls: string[] = await this.pageService.readAllAlbumTracks(page);

			let newTracksCount: number = 0;
			const { entity, isInserted } = await this.database.item.insert(albumUrl);
			if (isInserted) {
				newTracksCount++;
			}

			for (const trackUrl of tracksUrls) {
				await this.database.item.insertTrackToAlbum(trackUrl, entity)
			}

			return { extractedTracksCount: tracksUrls.length, newTracksCount }
		} catch (error) {
			logger.error(error, logMessage(LogSource.Item, `Album Tracks processing failed: ${error.message}`, url));
		}

		return null;
	}

	private async readAndSaveTrackAlbum(
		page: Page,
		trackUrl: string,
	): Promise<{ albumExtracted: boolean, albumRelationAlreadyExist: boolean }> {
		const url: string = page.url();
		try {
			const albumUrl: string = await this.pageService.readTrackAlbum(page);
			const { entity } = await this.database.item.insert(albumUrl);
			if (!isNullOrUndefined(albumUrl)) {
				const added = await this.database.item.insertTrackToAlbum(trackUrl, entity);

				return { albumExtracted: true, albumRelationAlreadyExist: !added };
			}
		} catch (error) {
			logger.error(error, logMessage(LogSource.Item, `Track Album processing failed: ${error.message}`, url));
		}

		return null;
	}
}
