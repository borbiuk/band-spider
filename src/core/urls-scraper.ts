import puppeteer from 'puppeteer';
import { logger } from '../common/logger';
import { delay, divideArray, isAlbum, isNullOrUndefined, isTrack, onlyUniqueScrapResult, originalUrl } from '../common/utils';
import { Database } from '../data/db';
import { readUrlsFromFile } from '../data/file';
import { Item } from '../models/base/item';
import { UrlScrapResult } from '../models/url-scrap-result';

/*
	#############################################################################
	#									DATA:									#
	#############################################################################
*/

const readUrlsFromDb = async (): Promise<Item[]> => {
	const database = await Database.initialize();
	
	const albums = await database.getAllAlbums();
	const tracks = await database.getAllTracks();
	return [...albums, ...tracks]
		.filter(x => !isNullOrUndefined(x));
}

const saveRelations = async (
	res: UrlScrapResult[],
	urlId: { [url: string]: number },
	accountId: { [url: string]: number }
): Promise<number> => {
	let relationsCount = 0;
	const database = await Database.initialize();
	
	for (let i = 0; i < res.length; i++) {
		const { url, urls } = res[i];

		if (!isAlbum(url) && !isTrack(url)) {
			continue;
		}

		const id = urlId[url];
		for (let j = 0; j < urls.length; j++) {
			const accountUrl = urls[j];
			const accId = accountId[accountUrl];
			const added = await database.insertItemToAccount(id, accId);
			if (added) {
				relationsCount++;
			}
		}
	}
	return relationsCount;
}

const saveAccounts = async (
	res: UrlScrapResult[]
) => {
	const database = await Database.initialize();
	
	const accountId: { [url: string]: number } = {};
	const uniqueAccounts = res.filter(onlyUniqueScrapResult);
	let savedAccountsCount = 0;
	for (let a of uniqueAccounts){
		for (let b of a.urls) {
			const id = await database.insertAccount(b);
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

const saveUrls = async (
	res: UrlScrapResult[]
) => {
	const database = await Database.initialize();
	
	const urlId: { [url: string]: number } = {};
	const uniqueResults = res.filter(onlyUniqueScrapResult);

	let savedAlbumsCount = 0;
	let savedTracksCount = 0;

	for (let i = 0; i < uniqueResults.length; i++) {
		const result = uniqueResults[i];
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

/*
	#############################################################################
	#							WEB PAGE FUNCTIONS:								#
	#############################################################################
*/

const LOAD_MORE_ACCOUNTS_RETRY: number = 5;
const LOAD_MORE_ACCOUNTS_DELAY: number = 1_000;
const LOAD_ACCOUNTS_CONTAINER: string = '.more-thumbs'
const showAllAccounts = async (page): Promise<void> => {
	let retry = 0;
	let count = 0;
	let error = null;

	while (retry < LOAD_MORE_ACCOUNTS_RETRY) {
		if (retry > 0) {
			await delay(LOAD_MORE_ACCOUNTS_DELAY);
		}

		try {
			const button = await page.$(LOAD_ACCOUNTS_CONTAINER);
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
};

const ACCOUNT_URL_CONTAINER: string = 'a.fan.pic';
const getPageAccounts = async (page): Promise<string[]> => {
	const hrefs: string[] = [];

	const elements = await page.$$(ACCOUNT_URL_CONTAINER);
	for (const e of elements) {
		const href = await e.getProperty('href');
		const hrefValue = await href.jsonValue();
		hrefs.push(
			originalUrl(hrefValue)
		);
	}

	return hrefs;
}

/*
	#############################################################################
	#								CORE FUNCTIONS:								#
	#############################################################################
*/

const OPEN_URL_DELAY: number = 500;
const scrapChunk = async (browser, items: Item[]): Promise<UrlScrapResult[]> => {
	const chunkResult: UrlScrapResult[] = [];

	// open new page
	const page = await browser.newPage();
	for (let i = 0; i < items.length; i++) {
		const albumOrTrackItem = items[i];

		await delay(OPEN_URL_DELAY);

		// open url and show all accounts
		await page.goto(albumOrTrackItem.url);
		await showAllAccounts(page);

		// scrap accounts
		const accountUrls = await getPageAccounts(page);
		logger.info(`${accountUrls.length} Accounts was read from ${albumOrTrackItem}`);

		chunkResult.push({
			url: albumOrTrackItem.url,
			urls: accountUrls,
		});
	}

	await page.close();

	return chunkResult;
}

const scrapTracksOrAlbumsChunks = async (tracksOrAlbumsChunks: Item[][], chunkIndex: number): Promise<void> => {
	console.time(`scrapChunks-${chunkIndex}`);

	// create browser
	const browser = await puppeteer.launch({
		headless: false,
	});

	// create parallel tasks
	const pagesPromises = tracksOrAlbumsChunks
		.map(async (items, index) => {
			try {
				return await scrapChunk(browser, items);
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
	const { urlId, savedAlbumsCount, savedTracksCount } = await saveUrls(pagesScrapingResult);
	logger.info(`${savedAlbumsCount} Albums was saved`, `${savedTracksCount} Tracks was saved`);

	//save accounts
	const { accountId, savedAccountsCount } = await saveAccounts(pagesScrapingResult);
	logger.info(`${savedAccountsCount} Accounts was saved`);

	//save relations
	const relationsCount = await saveRelations(pagesScrapingResult, urlId, accountId);
	logger.info(`${relationsCount} Relations was saved`);

	console.timeEnd(`scrapChunks-${chunkIndex}`);
}

const URLS_ON_PAGE: number = 1;
const PAGES_COUNT: number = 40;
export const urlsScraper = async (fromFile: boolean = true): Promise<void> => {
	console.time('accountScraper');

	// read URLs
	const sourceTracksOrAlbums = fromFile
		? readUrlsFromFile('source.txt').map(x => ({ url: x } as Item))
		: await readUrlsFromDb();
	logger.info(`${sourceTracksOrAlbums.length} links was read from ${fromFile ? 'file' : 'DB'}`);

	// create chunks
	const tracksOrAlbumsChunks: Item[][][] = divideArray(
		divideArray(sourceTracksOrAlbums, URLS_ON_PAGE),
		PAGES_COUNT
	);
	logger.info(`${tracksOrAlbumsChunks.length} was created`, `pages count - ${PAGES_COUNT}`, `URL on page - ${PAGES_COUNT}`);

	// process chunks
	for (let i = 0; i < tracksOrAlbumsChunks.length; i++) {
		const chunk = tracksOrAlbumsChunks[i];
		try {
			await scrapTracksOrAlbumsChunks(chunk, i);
			logger.success(`[${i}] CHUNK PROCESSED SUCCESSFULLY ! (${chunk.flat().length} urls)`);
		} catch (e) {
			logger.error(e, `[${i}] CHUNK PROCESSING FAILED !`);
		}
	}

	console.timeEnd('accountScraper');
};

