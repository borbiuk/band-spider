// Click the "Load More" button until all values are loaded
import puppeteer from 'puppeteer';
import { log } from '../common/log';
import { chunkArray, createChunks, delay, isAlbum, isTrack, originalUrl } from '../common/utils';
import {
	createTables,
	getAccountId, getAlbumId,
	getAllAlbums,
	getAllTracks,
	getTrackId,
	insertAccount, insertAlbum,
	insertAlbumToAccount,
	insertTrack,
	insertTrackToAccount
} from '../data/db';
import { readUrlsFromFile } from '../data/file';

const loadAllAccounts = async (page) => {
	let loadMoreButton;
	let retry = 0;
	while (retry < 3) {
		await delay(250);

		loadMoreButton = await page.$('.more-thumbs');
		if (!loadMoreButton) {
			retry++;
			continue;
		}

		try {
			await loadMoreButton.click();
			log(`"Load more..." button clicked: ${page.url()}`);
		} catch {
			retry++;
		}
	}
};

// Scrape hrefs from <a class="fan pic"></a> elements
const getAccounts = async (page) => {
	const hrefs = [];

	await delay(250);
	
	const fanPics = await page.$$('a.fan.pic');
	for (const fanPic of fanPics) {
		const href = await fanPic.getProperty('href');
		const hrefValue = await href.jsonValue();
		hrefs.push(
			originalUrl(hrefValue)
		);
	}

	return hrefs;
}

const scrapeAlbumOrTrackAccounts = async (trackOrAlbumUrl) => {
	const browser = await puppeteer.launch();
	const page = await browser.newPage();
	await page.goto(trackOrAlbumUrl);

	log('Album opened: ' + page.url());

	await loadAllAccounts(page);
	const accountUrls = await getAccounts(page);

	await browser.close();

	log('Albums founded: ' + page.url(), accountUrls);
	return accountUrls;
};

const accountScraper = async () => {
	console.time('accountScraper');

	// Read URLs from file
	const sourceTracksOrAlbums = readUrlsFromFile('source.txt');
	// const albums = await getAllAlbums();
	// const tracks = await getAllTracks();
	//
	// const sourceTracksOrAlbums = [...albums, ...tracks].map(({url}) => url);

	log(`[${sourceTracksOrAlbums.length}] urls will be processed`)

	// Chunk URLs into smaller batches
	const chunkSize = 1;
	const trackOrAlbumsChunks = chunkArray(sourceTracksOrAlbums, chunkSize);

	log(`Chunk size: ${chunkSize}`);
	log(`Chunks count: ${trackOrAlbumsChunks.length}`);

	// Create database tables
	await createTables();

	// Process URL chunks in parallel
	for (let i = 0; i < trackOrAlbumsChunks.length; i++) {
		log(`Chunk [${i}] started`);
		console.time(`chunkTimer-${i}`);

		const trackOrAlbumsChunk = trackOrAlbumsChunks[i];
		const scrapePromises = trackOrAlbumsChunk.map(async (trackOrAlbum, index) => {
			const isAlbumThenTrack = isAlbum(trackOrAlbum) ? true : isTrack(trackOrAlbum) ? false : null;
			if (isAlbumThenTrack === null) {
				return;
			}

			// Scrape the page and get hrefs
			const accounts = await scrapeAlbumOrTrackAccounts(trackOrAlbum);

			// Save URL to Account table
			accounts.forEach((account) => insertAccount(account));

			if (isAlbumThenTrack) {
				// Save URL to Album table
				insertAlbum(trackOrAlbum);

				// Save Accounts related to Album
				const albumId = await getAlbumId(trackOrAlbum);
				await Promise.all(accounts.map(async x => {
					const accountId = await getAccountId(x);
					await insertAlbumToAccount(albumId, accountId);
				}));
			} else {
				// Save URL to Track table
				insertTrack(trackOrAlbum);

				// Save Accounts related to Track
				const trackId = await getTrackId(trackOrAlbum);
				await Promise.all(accounts.map(async x => {
					const accountId = await getAccountId(x);
					await insertTrackToAccount(trackId, accountId);
				}));
			}
		});

		await Promise.all(scrapePromises);

		log(`Chunk [${i}] finished`);
		console.timeEnd(`chunkTimer-${i}`);
	}

	console.timeEnd('accountScraper');
};

module.exports = {
	accountScraper
};
