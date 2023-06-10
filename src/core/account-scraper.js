const puppeteer = require('puppeteer');
const utils = require("../common/utils");
const db = require("../data/db");
const file = require("../data/file");
const {log} = require("../common/log");

const isAlbum = (url) => url.includes('/album/');
const isTrack = (url) => url.includes('/track/');

// Click the "Load More" button until all values are loaded
const loadAllAccounts = async (page) => {
	let loadMoreButton;
	let retry = 0;
	while (retry < 3) {
		if (retry !== 0) {
			await utils.delay(2_000);
		}

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

	const fanPics = await page.$$('a.fan.pic');
	for (const fanPic of fanPics) {
		const href = await fanPic.getProperty('href');
		const hrefValue = await href.jsonValue();
		hrefs.push(hrefValue.split('?')[0]);
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
	console.time('all');

	// Read URLs from file
	const sourceTracksOrAlbums = file.readUrlsFromFile('source.txt');

	log(`[${sourceTracksOrAlbums.length}] urls will be processed`)

	// Chunk URLs into smaller batches
	const chunkSize = 20;
	const trackOrAlbumsChunks = utils.chunkArray(sourceTracksOrAlbums, chunkSize);

	log(`Chunk size: ${chunkSize}`);
	log(`Chunks count: ${trackOrAlbumsChunks.length}`);

	// Create database tables
	await db.createTables();

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
				db.insertAlbum(trackOrAlbum);

				// Save Accounts related to Album
				const albumId = await db.getAlbumId(trackOrAlbum);
				await Promise.all(accounts.map(async x => {
					const accountId = await db.getAccountId(x);
					await db.insertAlbumToAccount(albumId, accountId);
				}));
			} else {
				// Save URL to Track table
				db.insertTrack(trackOrAlbum);

				// Save Accounts related to Track
				const trackId = await db.getTrackId(trackOrAlbum);
				await Promise.all(accounts.map(async x => {
					const accountId = await db.getAccountId(x);
					await db.insertTrackToAccount(trackId, accountId);
				}));
			}
		});

		await Promise.all(scrapePromises);

		log(`Chunk [${i}] finished`);
		console.timeEnd(`chunkTimer-${i}`);
	}

	console.timeEnd('all');
};

module.exports = {
	accountScraper
};
