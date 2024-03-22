import { delay, originalUrl } from '../../common/utils';

export class ItemPageService {
	private readonly LOAD_MORE_ACCOUNTS_RETRY: number = 3;
	private readonly LOAD_MORE_ACCOUNTS_DELAY: number = 1_000;

	private readonly LOAD_ACCOUNTS_CONTAINER: string = '.more-thumbs'

	private readonly ACCOUNT_URL_CONTAINER: string = 'a.fan.pic';

	constructor(private readonly page) {
	}

	/**
	 * Retrieves account URLs from a page.
	 * This function clicks on a button to load more accounts on the page, and then extracts the URLs of the loaded accounts.
	 * If loading more accounts fails, it retries a specified number of times with a delay between retries.
	 * @param page - The Puppeteer page from which to retrieve account URLs.
	 * @returns A Promise resolving to an array of account URLs.
	 */
	public async readAllPageAccounts(page): Promise<string[]> {
		const hrefs: string[] = [];

		const elements = await page.$$(this.ACCOUNT_URL_CONTAINER);
		for (const e of elements) {
			const href = await e.getProperty('href');
			const hrefValue = await href.jsonValue();
			hrefs.push(
				originalUrl(hrefValue)
			);
		}

		return hrefs;
	}

	private async loadAllAccount(): Promise<void> {
		let retry: number = 0;

		while (retry < this.LOAD_MORE_ACCOUNTS_RETRY) {
			if (retry > 0) {
				await delay(this.LOAD_MORE_ACCOUNTS_DELAY);
			}

			try {
				const button = await this.page.$(this.LOAD_ACCOUNTS_CONTAINER);
				await button.click();
			} catch (e) {
				retry++;
			}
		}
	}
}
