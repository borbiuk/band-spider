import type { Browser, HTTPResponse, LaunchOptions, Page } from 'puppeteer';
import type { PuppeteerExtra } from 'puppeteer-extra';
import { logger, LogSource } from '../../common/logger';
import { isNullOrUndefined, logMessage } from '../../common/utils';
import { BrowserPageReader, PageSource } from '../page-reader';

/** Where `--docker` connects to: the browserless container of `scripts/browserless.sh`. */
export const BROWSERLESS_ENDPOINT = 'ws://localhost:3000';

// The page is replaced often to free the memory of the renderer, the whole browser rarely.
export const PAGE_RECREATE_INTERVAL = 1;
export const BROWSER_RELAUNCH_INTERVAL = 500;

let puppeteerWithStealth: Promise<PuppeteerExtra> | undefined;

/**
 * Loads Puppeteer and registers the stealth plugin, once. The packages are loaded on first use, so
 * the HTTP mode does not load Puppeteer at all.
 */
const loadPuppeteer = (): Promise<PuppeteerExtra> => {
	puppeteerWithStealth ??= (async () => {
		const extra = await import('puppeteer-extra');
		const stealth = await import('puppeteer-extra-plugin-stealth');

		// `puppeteer-extra` is CommonJS: `import()` wraps its `module.exports` in `default`. The types
		// describe the ES module shape, so the cast is needed.
		const puppeteer = extra.default as unknown as PuppeteerExtra;
		puppeteer.use(stealth.default());
		return puppeteer;
	})();
	return puppeteerWithStealth;
};

/** Command line flags of a locally launched Chrome. */
export const CHROME_ARGS: string[] = [
	'--disable-accelerated-2d-canvas',
	'--disable-background-timer-throttling',
	'--disable-backgrounding-occluded-windows',
	'--disable-breakpad',
	'--disable-client-side-phishing-detection',
	'--disable-component-extensions-with-background-pages',
	'--disable-default-apps',
	'--disable-dev-shm-usage',
	'--disable-extensions',
	'--disable-gpu',
	'--disable-infobars',
	'--disable-popup-blocking',
	'--disable-setuid-sandbox',
	'--dns-server=1.1.1.1',
	'--ignore-certificate-errors',
	'--incognito',
	'--no-first-run',
	'--no-sandbox',
	'--no-zygote',
	'--performance',
	'--window-size=1200,800',
	//'--single-process',
];

/** The part of a Puppeteer request that `shouldBlock` reads. */
export interface InterceptedRequest {
	resourceType(): string;
	method(): string;
	url(): string;
}

/** Tells if a request of a headless page is not needed to read Bandcamp pages. */
export function shouldBlock(request: InterceptedRequest): boolean {
	if ([
		'font',
		'image',
		'media'
	].includes(request.resourceType())) {
		return true;
	}

	const url = request.url();

	// Account tabs are read from the fan collection API, so every method of it is needed.
	if (request.method() === 'POST' && !url.startsWith('https://bandcamp.com/api/fancollection/1/')) {
		return true;
	}

	return url.includes('recaptcha')
		|| url.includes('gstatic.com')
		|| url.includes('googletagmanager.com')
		|| url.includes('google.com')
		|| url.includes('bandcamp.com/api/currency_data');
}

export interface BrowserPoolOptions {
	headless: boolean;
	/** Connect to the browserless container instead of launching Chrome. */
	docker: boolean;
	/** Called for every HTTP 429 answer a page gets. Must start the shared pause. */
	onRateLimited: (url: string, retryAfter?: string) => void;
}

/**
 * The browsers of all workers, one per worker id. Puppeteer with the stealth plugin is loaded before
 * the first browser starts.
 */
export class BrowserPool {
	private readonly browsers: { [id: number]: Browser } = {};

	constructor(private readonly options: BrowserPoolOptions) {
	}

	/** Closes the browser of the worker, if any, launches a new one and returns its first page. */
	public async recreateBrowser(id: number, safe = true): Promise<Page> {
		try {
			const existed = this.browsers[id];
			if (!isNullOrUndefined(existed)) {
				await existed.close();
				logger.debug(
					logMessage(LogSource.Browser, `[${String(id).padEnd(2)}] closed!`)
				);
			}

			const browser = await this.getBrowser();
			this.browsers[id] = browser;

			logger.debug(
				logMessage(LogSource.Browser, `[${String(id).padEnd(2)}] created!`)
			);
			return await this.getPage(browser, true);
		}
		catch (e) {
			if (!safe) {
				logger.error(e)
				throw e;
			}

			return await this.recreateBrowser(id, false);
		}

	}

	/** Closes the browser of the worker. With `--docker` this closes the remote browser too. */
	public async closeBrowser(id: number): Promise<void> {
		const browser = this.browsers[id];
		if (isNullOrUndefined(browser)) {
			return;
		}

		delete this.browsers[id];
		await browser.close();
		logger.debug(
			logMessage(LogSource.Browser, `[${String(id).padEnd(2)}] closed!`)
		);
	}

	/** Closes the page and opens a new one with the same setup in the same browser. */
	public async recreatePage(id: number, oldPage: Page): Promise<Page> {
		try {
			const page = await this.getPage(this.browsers[id], false);
			await oldPage.close().catch(() => { });
			return page;
		} catch (e) {
			logger.error(e, logMessage(LogSource.Browser, `[${String(id).padEnd(2)}] page recreation failed, relaunching browser`));
			return await this.recreateBrowser(id);
		}
	}

	private async getBrowser(): Promise<Browser> {
		const puppeteer = await loadPuppeteer();

		if (this.options.docker) {
			return await puppeteer.connect({
				browserWSEndpoint: BROWSERLESS_ENDPOINT,
			});
		} else {
			const launchOptions: LaunchOptions = {
				headless: this.options.headless,
				devtools: false,
				ignoreDefaultArgs: [
					'--enable-automation'
				],
				args: CHROME_ARGS,
				// The app handles SIGINT and SIGTERM itself: it finishes the current URL and closes the
				// browser. Puppeteer's own handlers would kill Chrome and exit at once. Chrome runs in its
				// own process group, so Ctrl-C in the terminal does not reach it.
				handleSIGINT: false,
				handleSIGTERM: false,
			};
			return await puppeteer.launch(launchOptions);
		}
	}

	private async getPage(
		browser: Browser,
		reuseFirstPage: boolean,
	): Promise<Page> {
		const pages = reuseFirstPage ? await browser.pages() : [];
		const page = isNullOrUndefined(pages) || pages.length === 0
			? await browser.newPage()
			: pages[0];

		// response handling
		// Every 429 answer of the page starts the pause, also one of a sub request. A 429 of the page
		// itself is also thrown by the reader as `RateLimitedError`, and `processUrl` handles that.
		page.on('response', (httpResponse: HTTPResponse) => {
			if (httpResponse.status() === 429) {
				this.options.onRateLimited(httpResponse.url(), httpResponse.headers()['retry-after']);
			}
		});

		// request filtering
		if (this.options.headless) {
			await page.setCacheEnabled(false);

			await page.setRequestInterception(true);
			page.on('request', (request) => {
				if (shouldBlock(request)) {
					request.abort();
					return;
				}

				request.continue();
			});
		}

		return page;
	}
}

/**
 * The browser of one worker. Its page is replaced after every URL and the whole browser after
 * `BROWSER_RELAUNCH_INTERVAL` URLs.
 */
export class BrowserPageSource implements PageSource {
	public readonly reader: BrowserPageReader;

	private processed = 0;

	private constructor(
		private readonly pool: BrowserPool,
		private readonly id: number,
		private page: Page,
	) {
		this.reader = new BrowserPageReader(page);
	}

	public static async create(pool: BrowserPool, id: number): Promise<BrowserPageSource> {
		return new BrowserPageSource(pool, id, await pool.recreateBrowser(id));
	}

	public async afterUrl(): Promise<void> {
		this.processed++;
		if (this.processed % BROWSER_RELAUNCH_INTERVAL === 0) {
			this.setPage(await this.pool.recreateBrowser(this.id));
		} else if (this.processed % PAGE_RECREATE_INTERVAL === 0) {
			this.setPage(await this.pool.recreatePage(this.id, this.page));
		}
	}

	/** Closes the page and the browser of this worker. */
	public async close(): Promise<void> {
		await this.page.close().catch(() => { });
		await this.pool.closeBrowser(this.id);
	}

	private setPage(page: Page): void {
		this.page = page;
		this.reader.replace(page);
	}
}
