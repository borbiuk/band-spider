import { Page } from 'puppeteer';
import { scrollPageToBottom } from 'puppeteer-autoscroll-down';
import { isEmptyString, isValidUrl, originalUrl } from '../../common/utils';

export class AccountPageService {

	private readonly ALBUM_OR_TRACK_URL_CONTAINER: string = '.item-link';

	private readonly LOAD_MORE_TRACKS_DELAY: number = 1_500;
	private readonly LOAD_MORE_TRACKS_CONTAINER: string = '.show-more';

	private readonly SCROLL_TO_END_RETRY: number = 3;
	private readonly SCROLL_SIZE: number = 5_000;
	private readonly SCROLL_REQUEST_ENDPOINT: string = 'collection_items';
	private readonly SCROLL_REQUEST_TIMEOUT: number = 1_000;
	private readonly SCROLL_CONTAINER: string = '.fan-container';

	constructor() {
	}

	public async readAllAccountItems(page: Page): Promise<string[]> {
		// show all album or tracks
		await this.clickShowAllItemsButton(page);
		await this.scrollToEnd(page);

		// read all album or tracks urls
		return (await this.readHrefs(page, this.ALBUM_OR_TRACK_URL_CONTAINER))
			.filter(x => isValidUrl(x))
			.map(x => originalUrl(x))
	}

	private async clickShowAllItemsButton(page: Page): Promise<void> {
		while (true) {
			try {
				const showMorePurchasesButton =
					await page.waitForSelector(
						this.LOAD_MORE_TRACKS_CONTAINER,
						{
							timeout: this.LOAD_MORE_TRACKS_DELAY
						});

				await showMorePurchasesButton.click();
			} catch {
				break;
			}
		}
	}

	private async scrollToEnd(page: Page): Promise<void> {
		let isLoadingAvailable = true;

		let container = await page.$(this.SCROLL_CONTAINER);
		let height = (await container.boundingBox()).height;
		let retry = 0;

		while (isLoadingAvailable && retry < this.SCROLL_TO_END_RETRY) {
			try {
				// scroll page
				// TODO: fix any
				await scrollPageToBottom(page as any, { size: this.SCROLL_SIZE });

				// wait response
				await page.waitForResponse(
					response => response.url().includes(this.SCROLL_REQUEST_ENDPOINT) && response.status() === 200,
					{
						timeout: this.SCROLL_REQUEST_TIMEOUT
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
		return await page.$$eval(selector, (elements) =>
			elements.map((element) => element.href)
		);
	}

}
