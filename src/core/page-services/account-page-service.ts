import { Page } from 'puppeteer';
import { scrollPageToBottom } from 'puppeteer-autoscroll-down';
import { isNullOrUndefined, isValidUrl, originalUrl } from '../../common/utils';

export class AccountPageService {
	private readonly DELAY: number = 3_000;

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
		while (true) {
			try {
				const showMorePurchasesButton =
					await page.waitForSelector(
						this.loadMoreAccountsSelector,
						{
							timeout: this.DELAY
						});

				await showMorePurchasesButton.click();
			} catch {
				break;
			}
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
				// scroll page
				// TODO: fix any
				await scrollPageToBottom(page as any, { size: 5_000 });

				// wait response
				await page.waitForResponse(
					response => response.url().includes(this.scrollRequestEndpointPath) && response.status() === 200,
					{
						timeout: this.DELAY
					}
				)

				// check is more scroll needed
				const currentHeight = (await container.boundingBox()).height;
				isLoadingAvailable = currentHeight !== height;
				if (!isLoadingAvailable) {
					return;
				}

				height = currentHeight;
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
