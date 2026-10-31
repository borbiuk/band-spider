import { UrlType } from './models/url-type';

export interface BandSpiderOptions {
	concurrencyBrowsers: number,
	headless: boolean,
	type: UrlType,
	docker: boolean,
	superTag: boolean,
	/** Read pages with Puppeteer instead of plain HTTP requests. */
	browser: boolean,
}

// Count of parallel URL workers (Browsers).
export const PARALLEL_BROWSERS_COUNT: number = 1;

/**
 * Reads the options from the command line arguments.
 *
 * @param args - The arguments after the script path (`process.argv.slice(2)`).
 */
export const parseOptions = (args: string[]): BandSpiderOptions => ({
	concurrencyBrowsers: PARALLEL_BROWSERS_COUNT,
	headless: args.includes('--headless'),
	type: args.includes('--account') ? UrlType.Account : UrlType.Item,
	docker: args.includes('--docker'),
	superTag: args.includes('--superTag'),
	browser: args.includes('--browser'),
});
