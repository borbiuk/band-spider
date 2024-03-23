import puppeteer, { Browser, Page } from 'puppeteer';
import { logger } from './logger';

export interface BrowserOptions {
	headless: boolean
}

const handlePage = async (
	browser: Browser,
	pageIndex: number,
	pageHandler: (page: Page) => Promise<void>
): Promise<void> => {
	let page: Page = null;
	try {
		// create a new page
		page = await browser.newPage();

		// run task in page
		await pageHandler(page);
	} catch (e) {

		// close page if exist
		if (page) {
			await page.close();
		}

		logger.error(e, `Page [${pageIndex}] was throw an error!`);
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
				await handlePage(browser, index, pageFunction)
			});

		// wait all tasks
		await Promise.all(promises)
	} catch (error) {

		// close browser if exist
		if (browser) {
			await browser.close();
		}

		logger.error(error, 'Browser was throw an error!');
	}
};
