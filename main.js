const {
	createTables,
	insertAccount,
	insertAlbum,
	insertAlbumToAccount,
	getAlbumId,
	getAccountId,
	insertTrackToAccount,
	getTrackId,
	insertTrack
} = require('./src/db');
const {scrapeAlbumOrTrackAccounts} = require('./src/core');
const {readUrlsFromFile} = require('./src/file');
const {chunkArray, isAlbum, isTrack} = require('./src/utils');
const {log} = require('./src/log');

const main = async () => {
	console.time('all');

	// Read URLs from file
	const sourceTracksOrAlbums = readUrlsFromFile('source.txt');

	log(`[${sourceTracksOrAlbums.length}] urls will be processed`)

	// Chunk URLs into smaller batches
	const chunkSize = 20;
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

	console.timeEnd('all');
};

process.setMaxListeners(0); // Set maximum listeners to unlimited

main();

