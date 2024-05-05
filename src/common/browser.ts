import { Browser, HTTPResponse, Page } from 'puppeteer';
import puppeteer from 'puppeteer-extra'
import { logger, LogSource } from './logger';
import { logMessage } from './utils';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { Cluster } from 'puppeteer-cluster';

export interface BrowserOptions {
	headless: boolean
}

const TOO_MANY_REQUESTS_STATUS_CODE: number = 429;

export const performInBrowser = async (
	pageHandler: (page: Page, pageIndex: number) => Promise<void>,
	pagesCount: number,
	browserOptions: BrowserOptions
): Promise<void> => {
	
	const cluster = await Cluster.launch({
		concurrency: Cluster.CONCURRENCY_CONTEXT,
		maxConcurrency: pagesCount,
	});

	await cluster.task(async ({ page, data: url, worker: { id } }) => {
		await pageHandler(page, 1);
	});

	let browser: Browser = null;
	try {
		puppeteer.use(StealthPlugin());

		// create a new browser
		browser = await puppeteer.launch({
			headless: browserOptions.headless,
			args: browserOptions.headless ? ['--no-sandbox'] : []
		});

		// create parallel tasks
		const promises = Array.from({ length: pagesCount })
			// .map(async (_, index) => {
			// 	await handlePage(browser, index, pageHandler);
			// 	logger.info(logMessage(LogSource.Page, `Page ${index} was finished`));
			// });
			.map((_, index) => handlePage(browser, index + 1, pageHandler))

		// wait all tasks
		await Promise.all(promises)
	} catch (error) {
		logger.error(error, logMessage(LogSource.Browser, `Browser was throw an error: ${error.message}`));
	}

	// close browser if exist
	if (browser) {
		await browser.close();
	}
};

const handlePage = async (
	browser: Browser,
	pageIndex: number,
	pageHandler: (page: Page, pageIndex: number) => Promise<void>
): Promise<void> => {
	return browser.newPage()
		.then((page: Page) => {
			logger.debug(logMessage(LogSource.Page, `Page ${pageIndex} was started`));

			configureRequestResponse(page, pageIndex);

			return pageHandler(page, pageIndex);
		})
		.catch((error) => {
			logger.error(error, logMessage(LogSource.Page, `Page ${pageIndex} was throw an error: ${error.message}`));
		})
		.finally(() => {
			logger.info(logMessage(LogSource.Page, `Page ${pageIndex} was finished`));
		});
};

export const configureRequestResponse = async (page: Page, pageIndex: number) => {
	await page.setRequestInterception(true);

	page.on('request', async request => {
		if (['stylesheet'].includes(request.resourceType())) {
			await request.abort();
		}
		else {
			await request.continue();
		}
	});

	page.on('response', async (response: HTTPResponse): Promise<void> => {
		if (response.status() !== TOO_MANY_REQUESTS_STATUS_CODE) {
			return;
		}

		logger.error(response, logMessage(LogSource.Page, `📡 Page ${pageIndex} \twas throw HTTP 429 TOO MANY REQUESTS`, response.url()));
	});
}
