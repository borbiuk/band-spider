import { Page } from 'puppeteer';
import { BrowserOptions, performInBrowser } from '../common/browser';
import { logger } from '../common/logger';
import { isAlbum, isNullOrUndefined, isTrack } from '../common/utils';
import { Database } from '../data/db';
import { readUrlsFromFile } from '../data/file';
import { ItemEntity } from '../entities/item-entity';
import { ItemPageService } from './page-services/item-page-service';

export class ItemsScrapper {
	public async run(
		fromFile: boolean = true,
		browserOptions: BrowserOptions,
		pagesCount: number
	): Promise<void> {
		const database: Database = await Database.initialize();

		// read URLs
		const items: ItemEntity[] = fromFile
			? readUrlsFromFile('items.txt').map(x => ({ url: x } as ItemEntity))
			: await database.getAllItems();

		logger.info(`Items to processing count: [${items.length}]`);

		const processedItems: string[] = [];

		// process chunks
		await performInBrowser(
			this.pageFunctionWrapper(database, items, processedItems),
			Math.min(pagesCount, items.length),
			browserOptions
		);
	}

	private pageFunctionWrapper(database: Database, items: ItemEntity[], processedItems: string[]) {
		return async (page: Page): Promise<void> => {
			const pageService = new ItemPageService();

			while (items.length > 0) {
				const item = items.pop();
				if (processedItems.includes(item.url)) {
					continue;
				}

				try {
					await this.processItem(page, pageService, database, item.url, items);
					processedItems.push(item.url);
					logger.info(`Processed count: [${processedItems.length}]`);
				} catch (error) {
					items.push(item);
					logger.error(error, item.url);
				}
			}
		};
	}

	private async processItem(
		page: Page,
		pageService: ItemPageService,
		database: Database,
		url: string,
		items: ItemEntity[]
	): Promise<void> {
		// open Item url
		await page.goto(url, { timeout: 10_000, waitUntil: 'networkidle0' });

		// save Item
		const { id } = await database.insertItem(url);

		// scrap and save Tags
		const tagsCount: number = await this.readAndSaveTags(page, pageService, database, id);

		// scrap and save Accounts
		const accountsCount: number = await this.readAndSaveAccount(page, pageService, database, id);

		// extract album or tracks
		let albumInfo = null;
		if (isAlbum(url)) {
			const albumLength: number = await this.readAndSaveAlbumTracks(page, pageService, database, url, items);
			albumInfo = {
				albumLength
			};
		} else if (isTrack(url)) {
			const albumExtracted: boolean = await this.readAndSaveTrackAlbum(page, pageService, database, url, items);
			albumInfo = {
				albumExtracted
			};
		}

		logger.info({
			message: 'Item processing finished!',
			url,
			accounts: accountsCount,
			tags: tagsCount,
			...albumInfo
		});
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
			logger.error(error, '')
		}

		return tagRelationsCount;
	}

	private async readAndSaveAccount(page: Page, service: ItemPageService, database: Database, itemId: number): Promise<number> {
		let accountsRelationsCount = 0;
		try {
			const accounts: string[] = await service.readAllPageAccounts(page);

			// save Accounts
			const accountsIds: number[] = [];

			for (const accountUrl of accounts) {
				const { id } = await database.insertAccount(accountUrl);
				accountsIds.push(id);
			}

			// save Accounts relations
			for (const accountId of accountsIds) {
				const added = await database.insertItemToAccount(itemId, accountId);
				if (added) {
					accountsRelationsCount++;
				}
			}
		} catch (error) {
			logger.error(error, '')
		}

		return accountsRelationsCount;
	}

	private async readAndSaveAlbumTracks(
		page: Page,
		pageService: ItemPageService,
		database: Database,
		url: string,
		items: ItemEntity[]
	): Promise<number> {
		const albumTracks: string[] = await pageService.readAllAlbumTracks(page);
		const albums = albumTracks.filter(x => !items.some(({ url }) => url === x));

		for (const albumUrl of albums) {
			items.push({
				url: albumUrl
			} as ItemEntity);
			await database.insertTrackToAlbum(albumUrl, url);
		}

		return albumTracks.length
	}

	private async readAndSaveTrackAlbum(
		page: Page,
		pageService: ItemPageService,
		database: Database,
		url: string,
		items: ItemEntity[]
	): Promise<boolean> {
		const albumUrl: string = await pageService.readTrackAlbum(page);
		if (
			!isNullOrUndefined(albumUrl)
			&& !items.some(({ url }) => url === albumUrl)
		) {
			items.push({ url: albumUrl } as ItemEntity);
			await database.insertTrackToAlbum(url, albumUrl);

			return true;
		}

		return false;
	}

}
