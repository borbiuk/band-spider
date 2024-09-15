import { ElementHandle, Page } from 'puppeteer';
import { logger, LogSource } from '../../../common/logger';
import { isAccountUrl, isItemUrl, isNullOrUndefined, logMessage, originalUrl } from '../../../common/utils';
import { AccountTab } from '../../../models/account-tab';
import { ProxyClient } from '../../proxy/proxy-client';
import { AccountPageData } from '../models/account-page-data';
import { AccountTabData, defaultPageReadResult, getPageReadErrorResult } from '../models/account-tab-data';

export async function readAccountPage(url: string, page: Page, pageIndex: number): Promise<AccountPageData> {
	try {
		await page.goto(url, { timeout: 2_500, waitUntil: 'domcontentloaded' });
	} catch (e) {
		if (e.message.includes('Navigation timeout')) {
			logger.warn(logMessage(LogSource.Account, `[${String(pageIndex).padEnd(2)}] Processing stopped`, url));
			ProxyClient.initialize.changeIp();
		}

		throw e;
	}

	const collection = await readAccountTab(page, AccountTab.Collection, 20);
	const wishlist = await readAccountTab(page, AccountTab.Wishlist, 20);
	const following = await readAccountTab(page, AccountTab.Following, 40);
	const followers = await readAccountTab(page, AccountTab.Followers, 45);

	return {
		url,
		collection,
		wishlist,
		following,
		followers,
		errors: [collection, wishlist, following, followers].map(x => x.error).filter(x => !isNullOrUndefined(x))
	}
}

/**
 * Reads data from the specified account page tab and returns a result containing the total number of items and their URLs.
 *
 * @param page - Puppeteer page instance.
 * @param tabType - Type of account tab to read (Collection, Wishlist, Followers, or Following).
 * @param countOnPage - The maximum number of items displayed on the page by default.
 * @returns A promise that resolves to the total number of items and their URLs.
 */
async function readAccountTab(page: Page, tabType: AccountTab, countOnPage: number): Promise<AccountTabData> {
	try {
		const totalCount = await getTabItemsCount(page, tabType);
		if (isNullOrUndefined(totalCount) || totalCount <= 0) {
			return defaultPageReadResult;
		}

		const container = await getTabContainer(page, tabType);
		if (isNullOrUndefined(container)) {
			return defaultPageReadResult;
		}

		if (totalCount > countOnPage) {
			await scrollTab(page, container);
		}

		const urls = await getTabUrls(container, tabType);

		return getReadPageResult(totalCount, urls);
	} catch (e) {
		return getPageReadErrorResult(e);
	}
}

/**
 * Retrieves the total count of items for the specified account tab and made it active.
 *
 * @param page - Puppeteer page instance.
 * @param tabType - Type of account tab to read.
 * @returns A promise that resolves to the total count of items in the tab.
 */
async function getTabItemsCount(page: Page, tabType: AccountTab): Promise<number> {
	let gridName: string;
	switch (tabType) {
		case AccountTab.Collection:
			gridName = 'collection'
			break;
		case AccountTab.Wishlist:
			gridName = 'wishlist'
			break;
		case AccountTab.Followers:
			gridName = 'followers'
			break;
		case AccountTab.Following:
			gridName = 'following'
			break;
	}

	const tabButtonContainer = await page.$(`[data-tab="${gridName}"]`);
	if (isNullOrUndefined(tabButtonContainer)) {
		return null;
	}

	await tabButtonContainer.click();
	if (tabType === AccountTab.Following) {
		const fansButtonContainer = await page.$('[data-tab="following-fans"]');
		if (isNullOrUndefined(fansButtonContainer)) {
			return null;
		}
		await fansButtonContainer.click();

		return fansButtonContainer.$eval(
			'.count',
			el => parseInt(el.textContent.trim())
		);
	}

	return await tabButtonContainer.$eval(
		'.count',
		el => parseInt(el.textContent.trim())
	);
}

/**
 * Retrieves the container for the specified account tab that contains needed URLs.
 *
 * @param page - Puppeteer page instance.
 * @param tabType - Type of account tab to read.
 * @returns A promise that resolves to the container element.
 */
async function getTabContainer(page: Page, tabType: AccountTab) {
	let containerId: string;
	switch (tabType) {
		case AccountTab.Collection:
			containerId = '#fan-container'
			break;
		case AccountTab.Wishlist:
			containerId = '#wishlist-items-container'
			break;
		case AccountTab.Followers:
			containerId = '#followers-container'
			break;
		case AccountTab.Following:
			containerId = '#following-fans-container'
			break;
	}

	return await page.$(containerId);
}

/**
 * Scrolls the specified account tab container to load and display all items.
 *
 * @param page - Puppeteer page instance.
 * @param container - The container element to scroll.
 */
async function scrollTab(page: Page, container: ElementHandle) {
	const showAllButton = await container.$('.show-more');
	await showAllButton.click();

	let isLoadingAvailable = true;
	let height = (await container.boundingBox()).height;
	let retry = 0;

	while (isLoadingAvailable && retry < 2) {
		try {
			// scroll to end
			// await page.evaluate(c => {
			// 	c.scrollBy(0, 1_000)
			// }, container)
			await page.evaluate((height: number) => {
				window.scrollTo(0, height * 10);
			}, height);

			// wait on loader
			await container.waitForSelector('svg.upload-spinner', { timeout: 700 });

			// check is more scroll needed
			const currentHeight = (await container.boundingBox()).height;
			isLoadingAvailable = currentHeight !== height;
			if (!isLoadingAvailable) {
				return;
			}

			height = currentHeight;
			retry = 0;
		} catch (e) {
			retry++;
		}
	}
}

/**
 * Retrieves the URLs from the specified account tab container.
 *
 * @param container - The container element from which to extract URLs.
 * @param tabType - Type of account tab to read.
 * @returns A promise that resolves to an array of URLs.
 */
async function getTabUrls(container: ElementHandle, tabType: AccountTab) {
	let selector: string;
	let convert: (urls: string[]) => string[];
	if (tabType === AccountTab.Collection || tabType === AccountTab.Wishlist) {
		selector = 'a.item-link';
		convert = (urls: string[]) => urls.filter(x => isItemUrl(x)).map(x => originalUrl(x));
	} else if (tabType === AccountTab.Followers || tabType === AccountTab.Following) {
		selector = 'a.fan-username';
		convert = (urls: string[]) => urls.filter(x => isAccountUrl(x));
	} else {
		return [];
	}

	const tabUrls = await container.$$eval(selector, (elements: HTMLAnchorElement[]) =>
		elements.map((element) => element.href)
	);

	return convert(tabUrls);
}

/**
 * Returns the final result of the account page operation, containing the total count and URLs.
 *
 * @param totalCount - The total number of items in the tab.
 * @param urls - The array of URLs extracted from the tab.
 * @returns The account page result with the total count and URLs.
 */
function getReadPageResult(totalCount: number, urls: string[]): AccountTabData {
	return {
		total: isNullOrUndefined(totalCount) || isNaN(totalCount) ? urls.length : totalCount,
		urls
	}
}

