import 'reflect-metadata';
import { BrowserOptions } from './common/browser';
import { AccountsScraper } from './core/accounts-scraper';
import { ItemsScrapper } from './core/items-scrapper';
import { Database } from './data/db';
import { readUrlsFromFile } from './data/file';

const PARALLEL_PAGES_COUNT: number = 80;

const main = async () => {
	console.time('main');

	// TODO: mode to separate script:
	// const d = await Database.initialize();
	// const e = readUrlsFromFile('source.txt');
	// const i = await d.getMostPopularItems(200, e);
	// i.forEach(({ url, count }) => {
	// 	console.log(url + `\t${count}`);
	// });
	//
	// return;

	const args = process.argv.slice(2);
	
	const browserOptions = {
		headless: true //args.includes('headless'),
	} as BrowserOptions;

	if (args.includes('urls')) {
		const fromFile = args.includes('from-file');
		const itemsScrapper = new ItemsScrapper();
		await itemsScrapper.run(fromFile, browserOptions, PARALLEL_PAGES_COUNT);
	} else if (args.includes('accounts')) {
		const accountScrapper = new AccountsScraper();
		await accountScrapper.run(browserOptions, PARALLEL_PAGES_COUNT);
	}

	console.timeEnd('main');
};

process.setMaxListeners(0); // Set maximum listeners to unlimited

main().catch(error => {
	console.log(error);
});

