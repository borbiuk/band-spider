import 'reflect-metadata';
import { logger, LogSource } from './common/logger';
import { logMessage } from './common/utils';
import { BandSpiderOptions, parseOptions } from './config';
import { BandSpider } from './core/band-spider';
import { SuperTagUpdate } from './core/super-tag-update';

const main = async (): Promise<void> => {

	// Read arguments
	const args: string[] = process.argv.slice(2);
	const options: BandSpiderOptions = parseOptions(args);

	// Run
	if (options.superTag) {
		return await new SuperTagUpdate().run(options);
	} else {
		return await new BandSpider().run(options);
	}
};


main().catch(error => {
	logger.fatal(error, logMessage(LogSource.Main, error.message));
});
