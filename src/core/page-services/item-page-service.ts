import { Page } from 'puppeteer';
import { logger, Source } from '../../common/logger';
import { isEmptyString, isNullOrUndefined, isValidUrl, logMessage, onlyUnique, originalUrl } from '../../common/utils';

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
		const url: string = page.url();

		await this.loadAllAccount(page);

		const accounts: string[] = await page
			.$$eval(
				this.ACCOUNT_URL_CONTAINER,
				(elements) => elements
					.map(x => x.getAttribute('href'))
			)
			.catch((error) => {
				logger.error(error, logMessage(Source.Item, error.message, url));
				return [];
			});

		return accounts
			.filter(x => !isNullOrUndefined(x))
			.map(x => originalUrl(x))
			.filter(onlyUnique);
	}

	public async readAllPageTags(page: Page): Promise<string[]> {
		const url: string = page.url();
		return await page
			.$$eval(
				this.TAG_URL_CONTAINER,
				tags => tags.map(x => x.textContent.trim())
			)
			.catch((error) => {
				logger.error(error, logMessage(Source.Item, error.message, url));
				return [];
			});
	};

	public async readAllAlbumTracks(page: Page): Promise<string[]> {

		const pageUrl = page.url();
		const url = new URL(pageUrl);
		const domain = url.protocol + '//' + url.hostname;

		const tracks: string[] = await page
			.$$eval(
				'table.track_list#track_table a',
				links => links.map(link => link.getAttribute('href'))
			)
			.catch(error => {
				logger.error(error, logMessage(Source.Item, error.message, pageUrl));
				return []
			});

		return tracks
			.filter(x => !isNullOrUndefined(x))
			.map(x => domain + originalUrl(x))
			.filter(x => isValidUrl(x))
			.filter(onlyUnique);
	}

	public async readTrackAlbum(page: Page): Promise<string> {

		const pageUrl = page.url();
		const url = new URL(page.url());
		const domain = url.protocol + '//' + url.hostname;

		let albumPath = await page
			.$eval(
				'#buyAlbumLink',
				element => element.getAttribute('href')
			)
			.catch((error) => {
				if (!error.message.includes('Error: failed to find element matching selector "#buyAlbumLink"')) {
					logger.error(error, logMessage(Source.Item, error.message, pageUrl));
				}
				return null;
			});

		return isEmptyString(albumPath)
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
