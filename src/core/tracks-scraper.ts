import puppeteer from 'puppeteer';
import { scrollPageToBottom } from 'puppeteer-autoscroll-down';
import { logger } from '../common/logger';
import { delay, divideArray, isAlbum, isEmptyString, isNullOrUndefined, isTrack, originalUrl } from '../common/utils';
import { getAlbumId, getAllAccounts, getTrackId, insertAlbum, insertAlbumToAccount, insertTrack, insertTrackToAccount } from '../data/db';
import { Account } from '../models/account';

/*
	#############################################################################
	#									DATA:									#
	#############################################################################
*/

const saveRelations = async (
	urlId: { [url: string]: number },
	accountUrls: { id: number, url: string }[]
): Promise<number> => {
	let relationsCount = 0;
	for (let i = 0; i < accountUrls.length; i++) {
		const { id, url } = accountUrls[i];

		let fn: (id1, id2,) => Promise<boolean>;
		if (isAlbum(url)) {
			fn = insertAlbumToAccount;
		}
		else if (isTrack(url)) {
			fn = insertTrackToAccount;
		}
		else {
			continue;
		}

		const urlsId = urlId[url];
		const added = await fn(urlsId, id);
		if (added) {
			relationsCount++;
		}
	}
	return relationsCount;
}

const saveUrls = async (
	accountUrls: { id: number, url: string }[]
) => {
	const urlId: { [url: string]: number } = {};
	let savedUrlsCount = 0;
	for (let i = 0; i < accountUrls.length; i++) {
		const { url } = accountUrls[i];

		if (isAlbum(url)) {
			let albumId = await getAlbumId(url) ?? await insertAlbum(url);
			if (albumId) {
				urlId[url] = albumId;
				savedUrlsCount++;
				continue;
			}
		}

		if (isTrack(url)) {
			let trackId = await getTrackId(url) ?? await insertTrack(url);
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

/*
	#############################################################################
	#							WEB PAGE FUNCTIONS:								#
	#############################################################################
*/

const LOAD_MORE_TRACKS_RETRY: number = 10;
const LOAD_MORE_TRACKS_DELAY: number = 2_000;
const LOAD_MORE_TRACKS_CONTAINER: string = '.show-more';
const showAllAlbumsOrTracks = async (page): Promise<void> => {
	let showMoreButton;
	let retry = 0;

	while (retry < LOAD_MORE_TRACKS_RETRY) {
		if (retry > 0) {
			await delay(LOAD_MORE_TRACKS_DELAY);
		}

		try {
			showMoreButton = await page.$(LOAD_MORE_TRACKS_CONTAINER);
			await showMoreButton.click();

			logger.info(`"button clicked [${retry}]`, page.url());
			break;
		}
		catch (e) {
			logger.error(e, `"Load more..." button error [${retry}]`, page.url());
			retry++;
		}
	}
}

const SCROLL_TO_END_RETRY: number = 5;
const SCROLL_SIZE: number = 5_000;
const SCROLL_REQUEST_ENDPOINT: string = 'collection_items';
const SCROLL_REQUEST_TIMEOUT: number = 1_000;
const SCROLL_CONTAINER: string = '.fan-container';
const scrollToEnd = async (page): Promise<void> => {
	let isLoadingAvailable = true;

	let container = await page.$(SCROLL_CONTAINER);
	let height = (await container.boundingBox()).height;
	let retry = 0;

	while (isLoadingAvailable && retry < SCROLL_TO_END_RETRY) {
		try {
			// scroll page
			await scrollPageToBottom(page, { size: SCROLL_SIZE });
			logger.info(`Scrolled [${retry}]`, page.url());

			// wait response
			await page.waitForResponse(
				response => response.url().includes(SCROLL_REQUEST_ENDPOINT) && response.status() === 200,
				{
					timeout: SCROLL_REQUEST_TIMEOUT
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

const loadAllTracks = async (page): Promise<void> => {
	try {
		await showAllAlbumsOrTracks(page);
		await scrollToEnd(page);
	} catch (e) {
		logger.error(e, 'loadAllTracks', page.url());
	}
};

const readHrefs = async (page, selector): Promise<string[]> => {
	return await page.$$eval(selector, (elements) =>
		elements.map((element) => element.href)
	);
};

/*
	#############################################################################
	#								CORE FUNCTIONS:								#
	#############################################################################
*/

const ALBUM_OR_TRACK_URL_CONTAINER: string = '.item-link';
const scrapChunk = async (browser, accounts: Account[]) => {
	const chunkResult: {
		id: number,
		urls: string[]
	}[] = [];

	const page = await browser.newPage();
	for (let i = 0; i < accounts.length; i++) {
		const { id, url } = accounts[i];

		// open account page
		await page.goto(url);

		// show all album or tracks
		await loadAllTracks(page);

		// read all album or tracks urls
		const urls = (await readHrefs(page, ALBUM_OR_TRACK_URL_CONTAINER))
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

const scrapChunks = async (chunk: Account[][], chunkIndex: number) => {
	console.time(`scrapChunks-${chunkIndex}`);

	// create browser
	const browser = await puppeteer.launch();

	// create parallel tasks
	const promises = chunk.map(async (accounts, index) => {
		try {
			return await scrapChunk(browser, accounts)
		} catch (e) {
			logger.error(e, `CHUNK [${chunkIndex}, ${index}] SCRAPING FAILED !`);
			return []
		}
	});

	// wait all tasks
	const result: {
		id: number,
		urls: string[]
	}[] = (await Promise.all(promises)).flat();

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
	const { urlId, savedUrlsCount } = await saveUrls(accountUrls);

	//save relations
	const relationsCount = await saveRelations(urlId, accountUrls);

	logger.info(savedUrlsCount, relationsCount);
	console.timeEnd(`scrapChunks-${chunkIndex}`);
}

const URLS_ON_PAGE = 1;
const PAGES_COUNT = 40;
export const tracksScraper = async () => {
	console.time('tracksScraper');

	// read URLs
	const allAccounts = (await getAllAccounts())
		.filter(({ id, url }) =>
			!isNullOrUndefined(id) && !isNullOrUndefined(url)
		);

	// create chunks
	const chunks: Account[][][] = divideArray(
		divideArray(allAccounts, URLS_ON_PAGE),
		PAGES_COUNT
	);

	for (let i = 0; i < chunks.length; i++) {
		const chunk = chunks[i];
		try {
			await scrapChunks(chunk, i);
			logger.success(`[${i}] CHUNK PROCESSED SUCCESSFULLY ! (${chunk.flat().length} accounts)`);
		} catch (e) {
			logger.error(e, `[${i}] CHUNK PROCESSING FAILED !`);
		}
	}

	console.timeEnd('tracksScraper');
}
