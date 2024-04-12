import 'reflect-metadata';
import { logger, LogSource } from './common/logger';
import { logMessage } from './common/utils';
import { BandSpider, UrlType } from './core/band-spider';

// Set maximum listeners to unlimited
process.setMaxListeners(0);

// 80 is good to avoid 429 response from bandcamp.com
const PARALLEL_PAGES_COUNT: number = 1;

const main = async (): Promise<void> => {

	// Read arguments
	const args: string[] = process.argv.slice(2);
	const headless: boolean = args.includes('--headless');
	const fromFile: boolean = args.includes('--file');
	const type: UrlType = args.includes('--account') ? UrlType.Account : UrlType.Item

	// Run
	await new BandSpider()
		.run(
			PARALLEL_PAGES_COUNT,
			headless,
			type,
			fromFile
		);
};


main().catch(error => {
	logger.fatal(error, logMessage(LogSource.Main, error.message));
});
