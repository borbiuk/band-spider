import { ElementHandle, Page } from 'puppeteer';
import { isAccountUrl, isItemUrl, isNullOrUndefined, originalUrl } from '../../common/utils';
import { AccountTab } from '../../models/account-tab';
import { defaultResult, PageReadResult } from '../../models/page-read-result';

/**
 * Service for interacting with account-related pages.
 */
export class AccountPageService {

	/**
	 * Reads data from the specified account page tab and returns a result containing the total number of items and their URLs.
	 *
	 * @param page - Puppeteer page instance.
	 * @param tabType - Type of account tab to read (Collection, Wishlist, Followers, or Following).
	 * @param countOnPage - The maximum number of items displayed on the page by default.
	 * @returns A promise that resolves to the total number of items and their URLs.
	 */
	public async read(page: Page, tabType: AccountTab, countOnPage: number): Promise<PageReadResult> {
		try {
			const totalCount = await this.getTabItemsCount(page, tabType);
			if (isNullOrUndefined(totalCount) || totalCount <= 0) {
				return defaultResult;
			}

			const container = await this.getTabContainer(page, tabType);
			if (isNullOrUndefined(container)) {
				return defaultResult;
			}

			if (totalCount > countOnPage) {
				await this.scrollTab(page, container);
			}

			const urls = await this.getTabUrls(container, tabType);

			return this.getResult(totalCount, urls);
		} catch (e) {
			return defaultResult;
		}
	}

	/**
	 * Retrieves the total count of items for the specified account tab and made it active.
	 *
	 * @param page - Puppeteer page instance.
	 * @param tabType - Type of account tab to read.
	 * @returns A promise that resolves to the total count of items in the tab.
	 */
	private async getTabItemsCount(page: Page, tabType: AccountTab): Promise<number> {
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
	private async getTabContainer(page: Page, tabType: AccountTab) {
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
	private async scrollTab(page: Page, container: ElementHandle) {
		const showAllButton = await container.$('.show-more');
		await showAllButton.click();

		let isLoadingAvailable = true;
		let height = (await container.boundingBox()).height;
		let retry = 0;

		while (isLoadingAvailable && retry < 2) {
			try {
				// scroll to end
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
	private async getTabUrls(container: ElementHandle, tabType: AccountTab) {
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
	private getResult(totalCount: number, urls: string[]): PageReadResult {
		return {
			total: isNullOrUndefined(totalCount) || isNaN(totalCount) ? urls.length : totalCount,
			data: urls
		}
	}
}
