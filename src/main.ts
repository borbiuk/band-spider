import 'reflect-metadata';
import { AccountsScraper } from './core/accounts-scraper';
import { ItemsScrapper } from './core/items-scrapper';

const main = async () => {
	console.time('main');

	const args = process.argv.slice(2);
	if (args.includes('urls')) {
		const fromFile = args.includes('from-file');
		const itemsScrapper = new ItemsScrapper();

		await itemsScrapper.run(fromFile);
	} else if (args.includes('accounts')) {
		const accountScrapper = new AccountsScraper();
		await accountScrapper.run();
	}

	console.timeEnd('main');
};

process.setMaxListeners(0); // Set maximum listeners to unlimited

main().catch(error => {
	console.log(error);
});

