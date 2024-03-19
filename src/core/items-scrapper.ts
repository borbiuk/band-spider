import puppeteer from 'puppeteer';
import { logger } from '../common/logger';
import { delay, divideArray, isAlbum, isNullOrUndefined, isTrack, onlyUniqueScrapResult, originalUrl } from '../common/utils';
import { Database } from '../data/db';
import { readUrlsFromFile } from '../data/file';
import { Item } from '../models/base/item';
import { UrlScrapResult } from '../models/url-scrap-result';

export class ItemsScrapper {
	private readonly URLS_ON_PAGE: number = 1;
	private readonly PAGES_COUNT: number = 40;
	private readonly OPEN_URL_DELAY: number = 500;
	private readonly ACCOUNT_URL_CONTAINER: string = 'a.fan.pic';
	private readonly LOAD_MORE_ACCOUNTS_RETRY: number = 5;
	private readonly LOAD_MORE_ACCOUNTS_DELAY: number = 1_000;
	private readonly LOAD_ACCOUNTS_CONTAINER: string = '.more-thumbs'
	
	private database: Database;

	public async run(fromFile: boolean = true): Promise<void> {
		console.time('accountScraper');

		this.database = await Database.initialize();

		// read URLs
		const sourceTracksOrAlbums = fromFile
			? readUrlsFromFile('source.txt').map(x => ({ url: x } as Item))
			: await this.readUrlsFromDb();
		logger.info(`${sourceTracksOrAlbums.length} links was read from ${fromFile ? 'file' : 'DB'}`);

		// create chunks
		const tracksOrAlbumsChunks: Item[][][] = divideArray(
			divideArray(sourceTracksOrAlbums, this.URLS_ON_PAGE),
			this.PAGES_COUNT
		);
		logger.info(`${tracksOrAlbumsChunks.length} was created`, `pages count - ${this.PAGES_COUNT}`, `URL on page - ${this.PAGES_COUNT}`);

		// process chunks
		for (let i = 0; i < tracksOrAlbumsChunks.length; i++) {
			const chunk = tracksOrAlbumsChunks[i];
			try {
				await this.scrapTracksOrAlbumsChunks(chunk, i);
				logger.success(`[${i}] CHUNK PROCESSED SUCCESSFULLY ! (${chunk.flat().length} urls)`);
			} catch (e) {
				logger.error(e, `[${i}] CHUNK PROCESSING FAILED !`);
			}
		}

		console.timeEnd('accountScraper');
	}

	private async readUrlsFromDb(): Promise<Item[]> {
		const albums = await this.database.getAllAlbums();
		const tracks = await this.database.getAllTracks();
		return [...albums, ...tracks]
			.filter(x => !isNullOrUndefined(x));
	}

	private async saveRelations(
		res: UrlScrapResult[],
		urlId: { [url: string]: number },
		accountId: { [url: string]: number }
	): Promise<number> {
		let relationsCount = 0;

		for (const element of res) {
			const { url, urls } = element;

			if (!isAlbum(url) && !isTrack(url)) {
				continue;
			}

			const id = urlId[url];
			for (const element of urls) {
				const accId = accountId[element];
				const added = await this.database.insertItemToAccount(id, accId);
				if (added) {
					relationsCount++;
				}
			}
		}
		return relationsCount;
	}

	private async saveAccounts(
		res: UrlScrapResult[]
	): Promise<{ savedAccountsCount: number; accountId: { [p: string]: number } }> {
		const accountId: { [url: string]: number } = {};
		const uniqueAccounts = res.filter(onlyUniqueScrapResult);
		let savedAccountsCount = 0;
		for (let a of uniqueAccounts) {
			for (let b of a.urls) {
				const id = await this.database.insertAccount(b);
				if (id) {
					accountId[b] = id;
					savedAccountsCount++;
					continue;
				}

				logger.warning('undefined', b);
			}
		}

		return { accountId, savedAccountsCount };
	}

	private async saveUrls(
		res: UrlScrapResult[]
	): Promise<{ savedTracksCount: number; savedAlbumsCount: number; urlId: { [p: string]: number } }> {
		const database = await Database.initialize();

		const urlId: { [url: string]: number } = {};
		const uniqueResults = res.filter(onlyUniqueScrapResult);

		let savedAlbumsCount = 0;
		let savedTracksCount = 0;

		for (const element of uniqueResults) {
			const result = element;
			if (isAlbum(result.url)) {
				const id = await database.insertItem(result.url)
				if (id) {
					urlId[result.url] = id;
					savedAlbumsCount++;
					continue;
				}
			}

			if (isTrack(result.url)) {
				let id = await database.insertItem(result.url)
				if (id) {
					urlId[result.url] = id;
					savedTracksCount++;
					continue;
				}
			}

			logger.warning('undefined', result);
		}
		return { urlId, savedAlbumsCount, savedTracksCount };
	}

	private async showAllAccounts(page): Promise<void> {
		let retry = 0;
		let count = 0;
		let error = null;

		while (retry < this.LOAD_MORE_ACCOUNTS_RETRY) {
			if (retry > 0) {
				await delay(this.LOAD_MORE_ACCOUNTS_DELAY);
			}

			try {
				const button = await page.$(this.LOAD_ACCOUNTS_CONTAINER);
				await button.click();

				logger.info(`button clicked [${count++}] (${page.url()})`);
			} catch (e) {
				retry++;
				error = e;
			}
		}

		if (retry > 0) {
			logger.error(error, `retry [${retry++}] (${page.url()})`);
		}
	}

	private async getPageAccounts(page): Promise<string[]> {
		const hrefs: string[] = [];

		const elements = await page.$$(this.ACCOUNT_URL_CONTAINER);
		for (const e of elements) {
			const href = await e.getProperty('href');
			const hrefValue = await href.jsonValue();
			hrefs.push(
				originalUrl(hrefValue)
			);
		}

		return hrefs;
	}

	private async scrapChunk(browser, items: Item[]): Promise<UrlScrapResult[]> {
		const chunkResult: UrlScrapResult[] = [];

		// open new page
		const page = await browser.newPage();
		for (const element of items) {
			const albumOrTrackItem = element;

			await delay(this.OPEN_URL_DELAY);

			// open url and show all accounts
			await page.goto(albumOrTrackItem.url);
			await this.showAllAccounts(page);

			// scrap accounts
			const accountUrls = await this.getPageAccounts(page);
			logger.info(`${accountUrls.length} Accounts was read from ${JSON.stringify(albumOrTrackItem)}`);

			chunkResult.push({
				url: albumOrTrackItem.url,
				urls: accountUrls,
			});
		}

		await page.close();

		return chunkResult;
	}

	private async scrapTracksOrAlbumsChunks(tracksOrAlbumsChunks: Item[][], chunkIndex: number): Promise<void> {
		console.time(`scrapChunks-${chunkIndex}`);

		// create browser
		const browser = await puppeteer.launch({
			headless: false,
		});

		// create parallel tasks
		const pagesPromises = tracksOrAlbumsChunks
			.map(async (items, index) => {
				try {
					return await this.scrapChunk(browser, items);
				} catch (e) {
					logger.error(e, `CHUNK [${chunkIndex}, ${index}] SCRAPING FAILED !`);
					return [];
				}
			});

		// wait all tasks
		const pagesScrapingResult = (await Promise.all(pagesPromises))
			.flat()
			.flat();

		// close browser
		await browser.close();

		//save urls
		const { urlId, savedAlbumsCount, savedTracksCount } = await this.saveUrls(pagesScrapingResult);
		logger.info(`${savedAlbumsCount} Albums was saved`, `${savedTracksCount} Tracks was saved`);

		//save accounts
		const { accountId, savedAccountsCount } = await this.saveAccounts(pagesScrapingResult);
		logger.info(`${savedAccountsCount} Accounts was saved`);

		//save relations
		const relationsCount = await this.saveRelations(pagesScrapingResult, urlId, accountId);
		logger.info(`${relationsCount} Relations was saved`);

		console.timeEnd(`scrapChunks-${chunkIndex}`);
	}
}
