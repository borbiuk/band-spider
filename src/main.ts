import { urlsScraper } from './core/urls-scraper';
import { accountsScraper } from './core/accounts-scraper';
import { createTables } from './data/db';

const main = async () => {
	console.time('main');

	await createTables();

	const args = process.argv.slice(2);
	if (args.includes('urls')) {
		const fromFile = args.includes('from-file');
		await urlsScraper(fromFile);
	}
	else if (args.includes('accounts')) {
		await accountsScraper();
	}

	console.timeEnd('main');
};

process.setMaxListeners(0); // Set maximum listeners to unlimited

main();

