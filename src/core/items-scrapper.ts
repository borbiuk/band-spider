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
		const database = await Database.initialize();

		// read URLs
		const items = fromFile
			? readUrlsFromFile('source.txt').map(x => ({ url: x } as ItemEntity))
			: await database.getAllItems();

		const processedItems: string[] = [];

		// process chunks
		await performInBrowser(
			this.pageFunctionWrapper(database, items, processedItems),
			pagesCount,
			browserOptions
		);
	}

	private pageFunctionWrapper(database: Database, items: ItemEntity[], processedItems: string[]) {
		return async (page: Page) => {
			const pageService = new ItemPageService();

			while (items.length > 0) {
				const item = items.pop();
				try {
					if (processedItems.includes(item.url)) {
						continue;
					}

					await this.handleItem(page, item.url, pageService, database, items);

					processedItems.push(item.url);
				} catch (error) {
					items.push(item);
					logger.error(error, item.url);
				}
			}
		};
	}

	private async handleItem(page: Page, url: string, pageService: ItemPageService, database: Database, items: ItemEntity[]) {
		// open url and show all accounts
		await page.goto(url, { waitUntil: 'networkidle0' });

		// scrap accounts
		const accountUrls = await pageService.readAllPageAccounts(page)

		// scrap tags
		const tags = await pageService.readAllPageTags(page);

		//save urls
		const urlId = await this.saveUrls(database, url);

		//save accounts
		const accountId = await this.saveAccounts(database, accountUrls);

		//save tags
		const tagId = await this.saveTags(database, tags);

		//save account relations
		const accountRelationsCount = await this.saveAccountsRelations(database, url, accountUrls, urlId, accountId);

		//save account relations
		const tagRelationsCount = await this.saveTagsRelations(database, url, tags, urlId, tagId);

		if (isAlbum(url)) {
			const albumTracks = await pageService.readAllAlbumTracks(page);
			const albums = albumTracks.filter(x => !items.some(({ url }) => url === x));
			for (const albumUrl of albums) {
				items.push({
					url: albumUrl
				} as ItemEntity);
				await database.insertTrackToAlbum(albumUrl, url);
			}
		} else if (isTrack(url)) {
			const albumUrl = await pageService.readTrackAlbum(page);
			if (
				!isNullOrUndefined(albumUrl)
				&& !items.some(({ url }) => url === albumUrl)
			) {
				items.push({ url: albumUrl } as ItemEntity);
				await database.insertTrackToAlbum(url, albumUrl);
			}
		}

		logger.success({
			message: '[Items] Relations was saved successfully!',
			url,
			accountsCount: accountRelationsCount,
			tagsCount: tagRelationsCount,
		});
	}

	private async saveAccountsRelations(
		database: Database,
		itemUrl: string,
		accountUrls: string[],
		urlId: { [url: string]: number },
		accountId: { [url: string]: number }
	): Promise<number> {
		let relationsCount = 0;

		const id = urlId[itemUrl];
		for (const element of accountUrls) {
			const accId = accountId[element];
			const added = await database.insertItemToAccount(id, accId);
			if (added) {
				relationsCount++;
			}
		}

		return relationsCount;
	}

	private async saveTagsRelations(
		database: Database,
		itemUrl: string,
		tags: string[],
		tagId: { [url: string]: number },
		accountId: { [url: string]: number }
	): Promise<number> {
		let relationsCount = 0;

		const id = tagId[itemUrl];
		for (const element of tags) {
			const accId = accountId[element];
			const added = await database.insertItemToTag(id, accId);
			if (added) {
				relationsCount++;
			}
		}

		return relationsCount;
	}

	private async saveAccounts(
		database: Database,
		urls: string[]
	): Promise<{ [p: string]: number }> {
		const accountId: { [url: string]: number } = {};

		for (const accountUrl of urls) {
			const id = await database.insertAccount(accountUrl);
			if (id) {
				accountId[accountUrl] = id;
			}
		}

		return accountId;
	}

	private async saveTags(
		database: Database,
		tags: string[]
	): Promise<{ [p: string]: number }> {
		const accountId: { [url: string]: number } = {};

		for (const tag of tags) {
			const { id } = await database.insertTag(tag);
			if (id) {
				accountId[tag] = id;
			}
		}

		return accountId;
	}

	private async saveUrls(
		database: Database,
		url: string
	): Promise<{ [p: string]: number }> {
		const urlId: { [url: string]: number } = {};

		const { id } = await database.insertItem(url)
		if (id) {
			urlId[url] = id;
		}

		return urlId;
	}
}
