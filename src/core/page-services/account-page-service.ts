import { Page } from 'puppeteer';
import { delay, isNullOrUndefined, isValidUrl, originalUrl } from '../../common/utils';

export class AccountPageService {
	private readonly DELAY: number = 10_000;

	private readonly itemSelector: string = '.item-link';
	private readonly loadMoreAccountsSelector: string = '.collection-items > .expand-container.show-button > .show-more';
	private readonly scrollRequestEndpointPath: string = 'collection_items';
	private readonly scrollContainer: string = '.fan-container';

	public async readAllAccountItems(page: Page): Promise<string[]> {
		// show all album or tracks
		await this.clickShowAllItemsButton(page);
		await this.scrollToEnd(page);

		// read all album or tracks urls
		return (await this.readHrefs(page, this.itemSelector))
			.filter(x => isValidUrl(x))
			.map(x => originalUrl(x))
	}

	private async clickShowAllItemsButton(page: Page): Promise<void> {
		try {
			const showMorePurchasesButton =
				await page.waitForSelector(
					this.loadMoreAccountsSelector,
					{
						timeout: 5_000,
						visible: true
					});

			await showMorePurchasesButton.click();
			await delay();
		}
		catch (e) {
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

				// wait response
				await page.waitForResponse(
					response => response.url().includes(this.scrollRequestEndpointPath) && response.status() === 200,
					{
						timeout: 5_000
					}
				);

				await delay();

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
