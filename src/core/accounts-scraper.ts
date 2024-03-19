import puppeteer from 'puppeteer';
import { scrollPageToBottom } from 'puppeteer-autoscroll-down';
import { logger } from '../common/logger';
import { delay, divideArray, isAlbum, isEmptyString, isNullOrUndefined, isTrack, originalUrl } from '../common/utils';
import { Database } from '../data/db';
import { Account } from '../models/account';
import { AccountScrapResult } from '../models/url-scrap-result';

export class AccountsScraper {
	private readonly URLS_ON_PAGE = 1;
	private readonly PAGES_COUNT = 40;
	private readonly LOAD_MORE_TRACKS_RETRY: number = 5;
	private readonly LOAD_MORE_TRACKS_DELAY: number = 1_000;
	private readonly LOAD_MORE_TRACKS_CONTAINER: string = '.show-more';
	private readonly SCROLL_TO_END_RETRY: number = 5;
	private readonly SCROLL_SIZE: number = 5_000;
	private readonly SCROLL_REQUEST_ENDPOINT: string = 'collection_items';
	private readonly SCROLL_REQUEST_TIMEOUT: number = 1_000;
	private readonly SCROLL_CONTAINER: string = '.fan-container';
	private readonly ALBUM_OR_TRACK_URL_CONTAINER: string = '.item-link';

	public async run(): Promise<void> {
		console.time('tracksScraper');

		const database = await Database.initialize();

		// read URLs
		const allAccounts = (await database.getAllAccounts())
			.filter(({ id, url }) =>
				!isNullOrUndefined(id) && !isNullOrUndefined(url)
			);

		// create chunks
		const chunks: Account[][][] = divideArray(
			divideArray(allAccounts, this.URLS_ON_PAGE),
			this.PAGES_COUNT
		);

		for (let i = 0; i < chunks.length; i++) {
			const chunk = chunks[i];
			try {
				await this.scrapChunks(chunk, i);
				logger.success(`[${i}] CHUNK PROCESSED SUCCESSFULLY ! (${chunk.flat().length} accounts)`);
			} catch (e) {
				logger.error(e, `[${i}] CHUNK PROCESSING FAILED !`);
			}
		}

		console.timeEnd('tracksScraper');
	}

	private async saveRelations(
		urlId: { [url: string]: number },
		accountUrls: { id: number, url: string }[]
	): Promise<number> {
		const database = await Database.initialize();

		let relationsCount = 0;
		for (const element of accountUrls) {
			const { id, url } = element;

			if (!isAlbum(url) && !isTrack(url)) {
				continue;
			}

			const urlsId = urlId[url];
			const added = await database.insertItemToAccount(urlsId, id);
			if (added) {
				relationsCount++;
			}
		}
		return relationsCount;
	}

	private async saveUrls(
		accountUrls: { id: number, url: string }[]
	): Promise<{ savedUrlsCount: number; urlId: { [p: string]: number } }> {
		const database = await Database.initialize();

		const urlId: { [url: string]: number } = {};
		let savedUrlsCount = 0;
		for (const element of accountUrls) {
			const { url } = element;

			if (isAlbum(url)) {
				let albumId = await database.insertItem(url);
				if (albumId) {
					urlId[url] = albumId;
					savedUrlsCount++;
					continue;
				}
			}

			if (isTrack(url)) {
				let trackId = await database.insertItem(url);
				if (trackId) {
					urlId[url] = trackId;
					savedUrlsCount++;
					continue;
				}
			}

			logger.warning('undefined', url);
		}
		return { urlId, savedUrlsCount };
	}

	private async showAllAlbumsOrTracks(page): Promise<void> {
		let retry = 0;

		while (retry < this.LOAD_MORE_TRACKS_RETRY) {
			if (retry > 0) {
				await delay(this.LOAD_MORE_TRACKS_DELAY);
			}

			try {
				const showMoreButton = await page.$(this.LOAD_MORE_TRACKS_CONTAINER);
				await showMoreButton.click();

				logger.info(`"button clicked [${retry}]`, page.url());
				break;
			} catch (e) {
				logger.error(e, `"Load more..." button error [${retry}]`, page.url());
				retry++;
			}
		}
	}

	private async scrollToEnd(page): Promise<void> {
		let isLoadingAvailable = true;

		let container = await page.$(this.SCROLL_CONTAINER);
		let height = (await container.boundingBox()).height;
		let retry = 0;

		while (isLoadingAvailable && retry < this.SCROLL_TO_END_RETRY) {
			try {
				// scroll page
				await scrollPageToBottom(page, { size: this.SCROLL_SIZE });
				logger.info(`Scrolled [${retry}]`, page.url());

				// wait response
				await page.waitForResponse(
					response => response.url().includes(this.SCROLL_REQUEST_ENDPOINT) && response.status() === 200,
					{
						timeout: this.SCROLL_REQUEST_TIMEOUT
					}
				)

				// check is more scroll needed
				const currentHeight = (await container.boundingBox()).height;
				isLoadingAvailable = currentHeight !== height;
				if (!isLoadingAvailable) {
					logger.info(`Scrolled to end [${retry}]:`, page.url());
					return;
				}

				height = currentHeight;
			} catch (e) {
				retry++;
				logger.error(e, `Scroll error [${retry}]`, page.url());
			}
		}
	}

	private async loadAllTracks(page): Promise<void> {
		try {
			await this.showAllAlbumsOrTracks(page);
			await this.scrollToEnd(page);
		} catch (e) {
			logger.error(e, 'loadAllTracks', page.url());
		}
	}

	private async readHrefs(page, selector: string): Promise<string[]> {
		return await page.$$eval(selector, (elements) =>
			elements.map((element) => element.href)
		);
	}

	private async scrapChunk(browser, accounts: Account[]): Promise<AccountScrapResult[]> {
		const chunkResult: AccountScrapResult[] = [];

		const page = await browser.newPage();
		for (const element of accounts) {
			const { id, url } = element;

			// open account page
			await page.goto(url);

			// show all album or tracks
			await this.loadAllTracks(page);

			// read all album or tracks urls
			const urls = (await this.readHrefs(page, this.ALBUM_OR_TRACK_URL_CONTAINER))
				.filter(x => !isEmptyString(x))
				.map(x => originalUrl(x));

			chunkResult.push({
				id,
				urls
			});
		}
		await page.close();

		return chunkResult;
	}

	private async scrapChunks(chunk: Account[][], chunkIndex: number): Promise<void> {
		console.time(`scrapChunks-${chunkIndex}`);

		// create browser
		const browser = await puppeteer.launch();

		// create parallel tasks
		const promises = chunk.map(async (accounts, index) => {
			try {
				return await this.scrapChunk(browser, accounts)
			} catch (e) {
				logger.error(e, `CHUNK [${chunkIndex}, ${index}] SCRAPING FAILED !`);
				return []
			}
		});

		// wait all tasks
		const result: AccountScrapResult[] = (await Promise.all(promises)).flat();

		// close browser
		await browser.close();

		const accountUrls = result
			.flat()
			.map(({ id, urls }) =>
				urls.map(url => ({
					id,
					url
				})))
			.flat();

		//save tracks
		const { urlId, savedUrlsCount } = await this.saveUrls(accountUrls);

		//save relations
		const relationsCount = await this.saveRelations(urlId, accountUrls);

		logger.info(savedUrlsCount, relationsCount);
		console.timeEnd(`scrapChunks-${chunkIndex}`);
	}
}



