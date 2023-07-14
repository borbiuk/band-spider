import puppeteer from 'puppeteer';
import { logger } from '../common/logger';
import { delay, divideArray, isAlbum, isNullOrUndefined, isTrack, onlyUnique, originalUrl } from '../common/utils';
import {
	getAccountId,
	getAlbumId,
	getAllAlbums,
	getAllTracks,
	getTrackId,
	insertAccount,
	insertAlbum,
	insertAlbumToAccount,
	insertTrack,
	insertTrackToAccount
} from '../data/db';
import { readUrlsFromFile } from '../data/file';

/*
	#############################################################################
	#									DATA:									#
	#############################################################################
*/

const readUrlsFromDb = async (): Promise<string[]> => {
	const albums = await getAllAlbums();
	const tracks = await getAllTracks();
	return [...albums, ...tracks]
		.map(({ url }) => url)
		.filter(x => !isNullOrUndefined(x));
}

const saveRelations = async (
	res: { url: string; accountUrls: string[] }[],
	urlId: { [url: string]: number },
	accountId: { [url: string]: number }
): Promise<number> => {
	let relationsCount = 0;
	for (let i = 0; i < res.length; i++) {
		const { url, accountUrls } = res[i];

		let fn: (id: number, accountId: number) => Promise<boolean>;
		if (isAlbum(url)) {
			fn = insertAlbumToAccount;
		}
		else if (isTrack(url)) {
			fn = insertTrackToAccount;
		}
		else {
			continue;
		}

		const id = urlId[url];
		for (let j = 0; j < accountUrls.length; j++) {
			const accountUrl = accountUrls[j];
			const accId = accountId[accountUrl];
			const added = await fn(id, accId);
			if (added) {
				relationsCount++;
			}
		}
	}
	return relationsCount;
}

const saveAccounts = async (
	res: { url: string; accountUrls: string[] }[]
) => {
	const accountId: { [url: string]: number } = {};
	const uniqueAccounts = res
		.map(x => x.accountUrls)
		.flat()
		.filter(onlyUnique);
	let savedAccountsCount = 0;
	for (let i = 0; i < uniqueAccounts.length; i++) {
		const url = uniqueAccounts[i];

		let id = (await getAccountId(url)) ?? (await insertAccount(url));
		if (id) {
			accountId[url] = id;
			savedAccountsCount++;
			continue;
		}

		logger.warning('undefined', url);
	}
	return { accountId, savedAccountsCount };
}

const saveUrls = async (
	res: { url: string; accountUrls: string[] }[]
) => {
	const urlId: { [url: string]: number } = {};
	const uniqueUrls = res
		.map(x => x.url)
		.filter(onlyUnique);
	let savedAlbumsCount = 0;
	let savedTracksCount = 0;
	for (let i = 0; i < uniqueUrls.length; i++) {
		const url = uniqueUrls[i];
		if (isAlbum(url)) {
			let id = await getAlbumId(url) ?? await insertAlbum(url);
			if (id) {
				urlId[url] = id;
				savedAlbumsCount++;
				continue;
			}
		}

		if (isTrack(url)) {
			let id = await getTrackId(url) ?? await insertTrack(url);
			if (id) {
				urlId[url] = id;
				savedTracksCount++;
				continue;
			}
		}

		logger.warning('undefined', url);
	}
	return { urlId, savedAlbumsCount, savedTracksCount };
}

/*
	#############################################################################
	#							WEB PAGE FUNCTIONS:								#
	#############################################################################
*/

const LOAD_MORE_ACCOUNTS_RETRY: number = 10;
const LOAD_MORE_ACCOUNTS_DELAY: number = 2_000;
const LOAD_ACCOUNTS_CONTAINER: string = '.more-thumbs'
const showAllAccounts = async (page): Promise<void> => {
	let button;
	let retry = 0;
	let count = 0;
	let error = null;

	while (retry < LOAD_MORE_ACCOUNTS_RETRY) {
		if (retry > 0) {
			await delay(LOAD_MORE_ACCOUNTS_DELAY);
		}

		try {
			button = await page.$(LOAD_ACCOUNTS_CONTAINER);
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
const scrapChunk = async (browser, urls: string[]): Promise<{
	url: string,
	accountUrls: string[]
}[]> => {
	const chunkResult: {
		url: string,
		accountUrls: string[]
	}[] = [];

	// open new page
	const page = await browser.newPage();
	for (let i = 0; i < urls.length; i++) {
		const albumOrTrackUrl = urls[i];

		await delay(OPEN_URL_DELAY);

		// open url and show all accounts
		await page.goto(albumOrTrackUrl);
		await showAllAccounts(page);

		// scrap accounts
		const accountUrls = await getPageAccounts(page);
		logger.info(`${accountUrls.length} Accounts was read from ${albumOrTrackUrl}`);

		chunkResult.push({
			url: albumOrTrackUrl,
			accountUrls: accountUrls
		});
	}

	await page.close();

	return chunkResult;
}

const scrapChunks = async (chunks: string[][], chunkIndex: number): Promise<void> => {
	console.time(`scrapChunks-${chunkIndex}`);

	// create browser
	const browser = await puppeteer.launch();

	// create parallel tasks
	const pagesPromises = chunks
		.map(async (hrefs, index) => {
			try {
				return await scrapChunk(browser, hrefs);
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
		? readUrlsFromFile('source.txt')
		: await readUrlsFromDb();
	logger.info(`${sourceTracksOrAlbums.length} links was read from ${fromFile ? 'file' : 'DB'}`);

	// create chunks
	const chunks: string[][][] = divideArray(
		divideArray(sourceTracksOrAlbums, URLS_ON_PAGE),
		PAGES_COUNT
	);
	logger.info(`${chunks.length} was created`, `pages count - ${PAGES_COUNT}`, `URL on page - ${PAGES_COUNT}`);

	// process chunks
	for (let i = 0; i < chunks.length; i++) {
		const chunk = chunks[i];
		try {
			await scrapChunks(chunk, i);
			logger.success(`[${i}] CHUNK PROCESSED SUCCESSFULLY ! (${chunk.flat().length} urls)`);
		} catch (e) {
			logger.error(e, `[${i}] CHUNK PROCESSING FAILED !`);
		}
	}

	console.timeEnd('accountScraper');
};

