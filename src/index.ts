import 'reflect-metadata';
import { logger, LogSource } from './common/logger';
import { logMessage } from './common/utils';
import { BandSpider, UrlType } from './core/band-spider';
import { SuperTagUpdate } from './core/super-tag-update';

export interface BandSpiderOptions {
	concurrencyBrowsers: number,
	headless: boolean,
	type: UrlType,
	fromFile: boolean,
	docker: boolean,
	superTag: boolean,
}

// Count of parallel URL workers (Browsers).
const PARALLEL_BROWSERS_COUNT: number = 12;

const main = async (): Promise<void> => {

	// Read arguments
	const args: string[] = process.argv.slice(2);
	const options: BandSpiderOptions = {
		concurrencyBrowsers: PARALLEL_BROWSERS_COUNT,
		headless: args.includes('--headless'),
		type: args.includes('--account') ? UrlType.Account : UrlType.Item,
		fromFile: args.includes('--file'),
		docker: args.includes('--docker'),
		superTag: args.includes('--superTag'),
	};

	// Run
	if (options.superTag) {
		await new SuperTagUpdate().run(options);
	}
	else {
		await new BandSpider().run(options);
	}
};


main().catch(error => {
	logger.fatal(error, logMessage(LogSource.Main, error.message));
});
