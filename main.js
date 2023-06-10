const {createTables, insertAccount, insertAlbum, insertAlbumToAccount, getAlbumId, getAccountId} = require('./src/db');
const {scrapePage} = require('./src/core');
const {readUrlsFromFile} = require('./src/file');
const {chunkArray} = require("./src/utils");

const main = async () => {
	// Read URLs from file
	const urls = readUrlsFromFile('source.txt');

	console.log(`[${urls.length}] urls will be processed`)

	// Chunk URLs into smaller batches
	const chunkSize = 8;
	const urlChunks = chunkArray(urls, chunkSize);

	console.log(`Chunk size: ${chunkSize}`);
	console.log(`Chunks count: ${urlChunks.length}`);

	// Create database tables
	await createTables();

	// Process URL chunks in parallel
	for (const chunk of urlChunks) {
		const scrapePromises = chunk.map(async (url, index) => {
			console.log(`Chunk [${index}] started`);
			console.time(`chunkTimer${index}`);

			const albumUrl = url.split('?')[0];

			// Save URL to Account table if it does not exist
			await insertAccount(url);

			// Scrape the page and get hrefs
			const hrefs = await scrapePage(albumUrl);

			// Save hrefs to Album table
			await Promise.all(hrefs.map((href) => insertAlbum(href)));

			// Save AlbumToAccount relationships
			const albumId = await getAlbumId(albumUrl);
			const accountId = await getAccountId(url);
			await insertAlbumToAccount(albumId, accountId);

			console.log(`Chunk [${index}] finished`);
			console.timeEnd(`chunkTimer${index}`);
		});

		await Promise.all(scrapePromises);
	}
};

process.setMaxListeners(0); // Set maximum listeners to unlimited
main();
