import { Page } from 'puppeteer';
import { logger, Source } from '../../common/logger';
import { isEmptyString, isNullOrUndefined, isValidDate, isValidUrl, logMessage, onlyUnique, originalUrl } from '../../common/utils';

export class ItemPageService {
	private readonly LOAD_MORE_ACCOUNTS_DELAY: number = 1_500;

	private readonly LOAD_ACCOUNTS_CONTAINER: string = '.more-thumbs'

	private readonly ACCOUNT_URL_CONTAINER: string = 'a.fan.pic';

	private readonly TAG_URL_CONTAINER: string = 'a.tag';

	private readonly ALBUM_URL_SELECTOR: string = '#buyAlbumLink';

	private readonly RELEASE_DATE_CONTAINER: string = '.tralbumData.tralbum-credits';

	private readonly releaseDateRegex: RegExp = /(?:released|releases) (\w+ \d{1,2}, \d{4})/;

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
				this.ALBUM_URL_SELECTOR,
				element => element.getAttribute('href')
			)
			.catch((error) => {
				if (!this.isFoundSelectorErrorMessage(error.message, this.ALBUM_URL_SELECTOR)) {
					logger.error(error, logMessage(Source.Item, error.message, pageUrl));
				}
				return null;
			});

		return isEmptyString(albumPath)
			? null
			: domain + albumPath;
	}

	public async readTrackReleaseDate(page: Page): Promise<Date> {
		const pageUrl = page.url();

		const content = await page
			.$eval(
				this.ALBUM_URL_SELECTOR,
				element => element.textContent
			)
			.catch(error => {
				if (!this.isFoundSelectorErrorMessage(error.message, this.RELEASE_DATE_CONTAINER)) {
					logger.error(error, logMessage(Source.Date, 'Item release date not found', pageUrl));
				}
				return null;
			});

		if (isNullOrUndefined(content)) {
			return null;
		}

		const match = content.match(this.releaseDateRegex);
		if (isNullOrUndefined(match) || match.length <= 1 || isNullOrUndefined(match[1])) {
			return null;
		}

		const date: Date = new Date(match[1]);
		return isValidDate(date) ? date : null;
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

	private isFoundSelectorErrorMessage(message: string, selector: string): boolean {
		return message.includes(`Error: failed to find element matching selector "${selector}"`);
	}
}
