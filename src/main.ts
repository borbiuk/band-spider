import 'reflect-metadata';
import { logger } from './common/logger';
import { BandSpider, InitType } from './core/band-spider';

const PARALLEL_PAGES_COUNT: number = 60;

const main = async (): Promise<void> => {
	console.time('main');

	const args = process.argv.slice(2);

	const scraper: BandSpider = new BandSpider();

	await scraper.run(
		PARALLEL_PAGES_COUNT,
		args.includes('--headless'),
		args.includes('--account') ? InitType.Account : InitType.Item,
		args.includes('--file')
	);

	console.timeEnd('main');
};

process.setMaxListeners(0); // Set maximum listeners to unlimited

main().catch(error => {
	logger.fatal(error, '[Main] thrown an error!');
});

