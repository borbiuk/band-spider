import { scrollPageToBottom } from 'puppeteer-autoscroll-down';
import { delay, isEmptyString, originalUrl } from '../../common/utils';

export class AccountPageService {

	private readonly ALBUM_OR_TRACK_URL_CONTAINER: string = '.item-link';

	private readonly LOAD_MORE_TRACKS_RETRY: number = 2;
	private readonly LOAD_MORE_TRACKS_DELAY: number = 1_500;
	private readonly LOAD_MORE_TRACKS_CONTAINER: string = '.show-more';

	private readonly SCROLL_TO_END_RETRY: number = 3;
	private readonly SCROLL_SIZE: number = 5_000;
	private readonly SCROLL_REQUEST_ENDPOINT: string = 'collection_items';
	private readonly SCROLL_REQUEST_TIMEOUT: number = 1_000;
	private readonly SCROLL_CONTAINER: string = '.fan-container';

	constructor(private readonly page) {
	}

	public async readAllPageAccounts(): Promise<string[]> {
		// show all album or tracks
		await this.clickShowAllItemsButton();
		await this.scrollToEnd();

		// read all album or tracks urls
		return (await this.readHrefs(this.page, this.ALBUM_OR_TRACK_URL_CONTAINER))
			.filter(x => !isEmptyString(x))
			.map(x => originalUrl(x))
	}

	private async clickShowAllItemsButton(): Promise<void> {
		let retry = 0;

		while (retry < this.LOAD_MORE_TRACKS_RETRY) {
			if (retry > 0) {
				await delay(this.LOAD_MORE_TRACKS_DELAY);
			}

			try {
				const showMoreButton = await this.page.$(this.LOAD_MORE_TRACKS_CONTAINER);
				await showMoreButton.click();

				break;
			} catch (e) {
				retry++;
			}
		}
	}

	private async scrollToEnd(): Promise<void> {
		let isLoadingAvailable = true;

		let container = await this.page.$(this.SCROLL_CONTAINER);
		let height = (await container.boundingBox()).height;
		let retry = 0;

		while (isLoadingAvailable && retry < this.SCROLL_TO_END_RETRY) {
			try {
				// scroll page
				await scrollPageToBottom(this.page, { size: this.SCROLL_SIZE });

				// wait response
				await this.page.waitForResponse(
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

	private async readHrefs(page, selector: string): Promise<string[]> {
		return await page.$$eval(selector, (elements) =>
			elements.map((element) => element.href)
		);
	}

}
