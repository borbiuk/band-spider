import { accountScraper } from './core/account-scraper';
import { tracksScraper } from './core/tracks-scraper';
import { createTables } from './data/db';

const main = async () => {
	console.time('main');

	await createTables();

	//await accountScraper(true);
	await tracksScraper();

	console.timeEnd('main');
};

process.setMaxListeners(0); // Set maximum listeners to unlimited

main();

