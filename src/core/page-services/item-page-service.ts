import { Page } from 'puppeteer';
import { logger } from '../../common/logger';
import { isNullOrUndefined, onlyUnique, originalUrl } from '../../common/utils';

export class ItemPageService {
	private readonly LOAD_MORE_ACCOUNTS_DELAY: number = 1_500;

	private readonly LOAD_ACCOUNTS_CONTAINER: string = '.more-thumbs'

	private readonly ACCOUNT_URL_CONTAINER: string = 'a.fan.pic';

	private readonly TAG_URL_CONTAINER: string = 'a.tag';

	constructor() {
	}

	/**
	 * Retrieves account URLs from a page.
	 * This function clicks on a button to load more accounts on the page, and then extracts the URLs of the loaded accounts.
	 * If loading more accounts fails, it retries a specified number of times with a delay between retries.
	 * @param page - The Puppeteer page from which to retrieve account URLs.
	 * @returns A Promise resolving to an array of account URLs.
	 */
	public async readAllPageAccounts(page: Page): Promise<string[]> {
		const hrefs: string[] = [];

		await this.loadAllAccount(page);

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

	public async readAllPageTags(page: Page): Promise<string[]> {
		return await page
			.$$eval(
				this.TAG_URL_CONTAINER,
				tags => tags.map(x => x.textContent.trim())
			)
			.catch((error) => {
				logger.error(error);
				return [];
			});
	};

	public async readAllAlbumTracks(page: Page): Promise<string[]> {

		const url = new URL(page.url());
		const domain = url.protocol + '//' + url.hostname;

		const tracks: string[] = await page
			.$$eval(
				'table.track_list#track_table a',
				links => links.map(link => link.getAttribute('href'))
			)
			.catch(error => {
				logger.error(error);
				return []
			});

		return tracks
			.filter(x => !isNullOrUndefined(x))
			.map(x => domain + originalUrl(x))
			.filter(onlyUnique);
	}

	public async readTrackAlbum(page: Page): Promise<string> {

		const url = new URL(page.url());
		const domain = url.protocol + '//' + url.hostname;

		let albumPath = await page
			.$eval(
				'a#buyAlbumLink',
				element => element.getAttribute('href')
			)
			.catch((error) => {
				logger.error(error);
				return null;
			});

		return isNullOrUndefined(albumPath)
			? null
			: domain + albumPath;
	}

	private async loadAllAccount(page: Page): Promise<void> {
		while (true) {
			try {
				const showMoreAccountsButton =
					await page.waitForSelector(
						this.LOAD_ACCOUNTS_CONTAINER,
						{
							timeout: this.LOAD_MORE_ACCOUNTS_DELAY
						});

				await showMoreAccountsButton.click();
			} catch {
				break;
			}
		}
	}
}
