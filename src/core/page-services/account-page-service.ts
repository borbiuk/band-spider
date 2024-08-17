import { Page } from 'puppeteer';
import { isNullOrUndefined, isValidUrl, originalUrl } from '../../common/utils';

export class AccountPageService {
	private readonly itemSelector: string = '.item-link';
	private readonly loadMoreAccountsSelector: string = '.collection-items > .expand-container.show-button > .show-more';
	private readonly scrollContainer: string = '.fan-container';
	private readonly collectionCountSelector = 'li[data-tab="collection"] .count';

	public async readAllAccountItems(page: Page): Promise<{ totalCount: number, itemsUrls: string[] }> {
		const totalCount = await this.getCollectionCount(page);

		// show all album or tracks
		if (totalCount > 40) {
			await this.clickShowAllItemsButton(page);
			await this.scrollToEnd(page);
		}

		const urls = (await this.readHrefs(page, this.itemSelector))
			.filter(x => isValidUrl(x))
			.map(x => originalUrl(x));

		// read all album or tracks urls
		return {
			totalCount: isNullOrUndefined(totalCount) || isNaN(totalCount) ? urls.length : totalCount,
			itemsUrls: urls
		};
	}

	private async getCollectionCount(page: Page): Promise<number> {
		try {
			const count = await page.$eval(this.collectionCountSelector, element => element.textContent.trim());
			return Number(count);
		} catch {
			return null;
		}
	}

	private async clickShowAllItemsButton(page: Page): Promise<void> {
		try {
			const showMorePurchasesButton =
				await page.waitForSelector(
					this.loadMoreAccountsSelector,
					{
						timeout: 2_000
					});

			await showMorePurchasesButton.click();
		} catch (e) {
		}
	}

	private async scrollToEnd(page: Page): Promise<void> {
		let isLoadingAvailable = true;

		const container = await page.$(this.scrollContainer);
		if (isNullOrUndefined(container)) {
			return;
		}

		let height = (await container.boundingBox()).height;

		let retry = 0;

		while (isLoadingAvailable && retry < 2) {
			try {
				// scroll to end
				await page.evaluate((height: number) => {
					window.scrollTo(0, height * 10);
				}, height);

				// wait on loader
				await page.waitForSelector('#collection-items .expand-container:not(.show-loading)', { timeout: 2_000 });

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

	private async readHrefs(page: Page, selector: string): Promise<string[]> {
		return await page.$$eval(selector, (elements: HTMLAnchorElement[]) =>
			elements.map((element) => element.href)
		);
	}

}
