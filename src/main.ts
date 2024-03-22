import 'reflect-metadata';
import { AccountsScraper } from './core/accounts-scraper';
import { ItemsScrapper } from './core/items-scrapper';
import { Database } from './data/db';
import { readUrlsFromFile } from './data/file';

const main = async () => {
	console.time('main');

	// TODO: mode to separate script:
	// const d = await Database.initialize();
	// const e = readUrlsFromFile('source.txt');
	// const i = await d.getMostPopularItems(100, e);
	// i.forEach(({ url, count }) => {
	// 	console.log(url + `\t${count}`);
	// });
	//
	// return;

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

