import { createTables } from './data/db';

const {accountScraper} = require("./core/account-scraper");
const {tracksScraper} = require("./core/tracks-scraper");

const main = async () => {
	console.time('main');

	await createTables();

	await accountScraper();
	//await tracksScraper();

	console.timeEnd('main');
};

process.setMaxListeners(0); // Set maximum listeners to unlimited

main();

