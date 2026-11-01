import { UrlType } from './models/url-type';

export interface BandSpiderOptions {
	concurrency: number,
	type: UrlType,
	superTag: boolean,
	/** Take the newest unprocessed URLs first (highest id), instead of the oldest. */
	reverse: boolean,
	/** Send the requests through this proxy URL (`--proxy <url>`). Without it the local IP is used. */
	proxy?: string,
	/** The random pause from the end of one request to the start of the next one. The HTTP client defaults are used when not set. */
	minDelayMs?: number,
	maxDelayMs?: number,
	/** When no URL is left, wait this long and try again, until stopped. Without it the run ends when the queue is empty (CLI). */
	idleWaitMs?: number,
}

// Count of parallel URL workers.
export const PARALLEL_WORKERS_COUNT: number = 1;

/**
 * Reads the options from the command line arguments.
 *
 * @param args - The arguments after the script path (`process.argv.slice(2)`).
 */
export const parseOptions = (args: string[]): BandSpiderOptions => ({
	concurrency: PARALLEL_WORKERS_COUNT,
	type: args.includes('--account') ? UrlType.Account : UrlType.Item,
	superTag: args.includes('--superTag'),
	reverse: args.includes('--reverse'),
	...proxyOption(args),
});

/** The value after `--proxy`, or nothing when the flag or its value is missing. */
const proxyOption = (args: string[]): { proxy?: string } => {
	const value = args[args.indexOf('--proxy') + 1];
	return args.includes('--proxy') && value !== undefined && !value.startsWith('--') ? { proxy: value } : {};
};
