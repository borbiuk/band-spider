import puppeteer, { Browser, HTTPResponse, Page } from 'puppeteer';
import { logger, Source } from './logger';
import { logMessage } from './utils';

export interface BrowserOptions {
	headless: boolean
}

const TOO_MANY_REQUESTS_STATUS_CODE: number = 429;

const handlePage = async (
	browser: Browser,
	pageIndex: number,
	pageHandler: (page: Page) => Promise<void>
): Promise<void> => {
	let page: Page = null;
	try {
		// create a new page
		page = await browser.newPage();
		await page.setViewport({ width: 1920, height: 1080 });

		logger.debug(logMessage(Source.Page, `Page ${pageIndex} was started`));

		page.on('response', async (response: HTTPResponse): Promise<void> => {
			if (response.status() !== TOO_MANY_REQUESTS_STATUS_CODE) {
				return;
			}

			logger.error(response, logMessage(Source.Page, `\t📡 Page ${pageIndex} \twas throw HTTP 429 TOO MANY REQUESTS`, response.url()));
		});

		// run task in page
		await pageHandler(page);
	} catch (error) {
		logger.error(error, logMessage(Source.Page, `Page ${pageIndex} was throw an error: ${error.message}`));
	}

	// close page if exist
	if (page) {
		await page.close();
	}
};

export const performInBrowser = async (
	pageFunction: (page: Page) => Promise<void>,
	pagesCount: number,
	browserOptions: BrowserOptions
): Promise<void> => {
	let browser: Browser = null;
	try {

		// create a new browser
		browser = await puppeteer.launch(browserOptions);

		// create parallel tasks
		const promises = Array.from({ length: pagesCount })
			.map(async (_, index) => {
				await handlePage(browser, index, pageFunction);
				logger.info(logMessage(Source.Page, `Page ${index} was finished`));
			});

		// wait all tasks
		await Promise.all(promises)
	} catch (error) {
		logger.error(error, logMessage(Source.Browser, `Browser was throw an error: ${error.message}`));
	}

	// close browser if exist
	if (browser) {
		await browser.close();
	}
};
