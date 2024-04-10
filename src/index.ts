import 'reflect-metadata';
import { logger, Source } from './common/logger';
import { logMessage } from './common/utils';
import { BandSpider, InitType } from './core/band-spider';

// Set maximum listeners to unlimited
process.setMaxListeners(0);

// 80 is good to avoid 429 response from bandcamp.com
const PARALLEL_PAGES_COUNT: number = 80;

const main = async (): Promise<void> => {

	// Read arguments
	const args: string[] = process.argv.slice(2);
	const headless: boolean = args.includes('--headless');
	const fromFile = args.includes('--file');
	const type: InitType = args.includes('--account') ? InitType.Account : InitType.Item

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
	logger.fatal(error, logMessage(Source.Main, error.message));
});
