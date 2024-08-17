import { Page } from 'puppeteer';
import { logger, LogSource } from '../../common/logger';
import { isAccountUrl, isEmptyString, isNullOrUndefined, isValidDate, isValidUrl, logMessage, onlyUnique, originalUrl } from '../../common/utils';

export class ItemPageService {
	private readonly loadAllAccountsSelector: string = 'a.more-thumbs'
	private readonly accountUrlSelector: string = 'a.fan.pic';
	private readonly albumUrlSelector: string = '#buyAlbumLink';
	private readonly albumTracksSelector: string = 'table.track_list#track_table a';
	private readonly releaseDateContainerSelector: string = '.tralbumData.tralbum-credits';
	private readonly tagSelector: string = 'a.tag';
	private readonly releaseDateRegex: RegExp = /(?:released|releases) (\w+ \d{1,2}, \d{4})/;

	/**
	 * Retrieves account URLs from a page.
	 * This function clicks on a button to load more accounts on the page, and then extracts the URLs of the loaded accounts.
	 * If loading more accounts fails, it retries a specified number of times with a delay between retries.
	 * @param page - The Puppeteer page from which to retrieve account URLs.
	 * @returns A Promise resolving to an array of account URLs.
	 */
	public async readAllPageAccounts(page: Page): Promise<string[]> {
		const url: string = page.url();

		try {
			let accounts = await this.getPageAccounts(page);
			if (accounts.length === 60) {
				await this.loadAllAccount(page);
				accounts = await this.getPageAccounts(page);
			}

			return accounts
				.map(x => originalUrl(x))
				.filter(x => isAccountUrl(x));
		} catch (error) {
			logger.error(error, logMessage(LogSource.Item, error.message, url));
			return [];
		}
	}

	public async readAllPageTags(page: Page): Promise<string[]> {
		const url: string = page.url();
		return await page
			.$$eval(
				this.tagSelector,
				tags => tags.map(x => x.textContent.trim())
			)
			.catch((error) => {
				logger.error(error, logMessage(LogSource.Item, error.message, url));
				return [];
			});
	};

	public async readAllAlbumTracks(page: Page): Promise<string[]> {
		const pageUrl = page.url();
		const url = new URL(pageUrl);
		const domain = url.protocol + '//' + url.hostname;

		const tracks: string[] = await page
			.$$eval(
				this.albumTracksSelector,
				links => links.map(link => link.getAttribute('href'))
			)
			.catch(error => {
				logger.error(error, logMessage(LogSource.Item, error.message, pageUrl));
				return [];
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
				this.albumUrlSelector,
				element => element.getAttribute('href')
			)
			.catch((error) => {
				if (!this.isFoundSelectorErrorMessage(error.message)) {
					logger.error(error, logMessage(LogSource.Item, error.message, pageUrl));
				}
				return null;
			});

		return isEmptyString(albumPath)
			? null
			: domain + albumPath;
	}

	public async readTrackReleaseDate(page: Page): Promise<Date> {
		const pageUrl: string = page.url();

		const content = await page
			.$eval(
				this.releaseDateContainerSelector,
				element => element.textContent
			)
			.catch(error => {
				if (!this.isFoundSelectorErrorMessage(error.message)) {
					logger.error(error, logMessage(LogSource.Date, 'Item release date not found', pageUrl));
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

	private async getPageAccounts(page: Page): Promise<string[]> {
		return await page.$$eval(
			this.accountUrlSelector,
			(elements) => elements
				.map(x => x.getAttribute('href'))
		);
	}

	private async loadAllAccount(page: Page): Promise<void> {
		try {
			const showMoreAccountsButton =
				await page.waitForSelector(
					this.loadAllAccountsSelector,
					{
						timeout: 2_000
					});

			await showMoreAccountsButton?.click();
		} catch {
		}
	}

	private isFoundSelectorErrorMessage(message: string): boolean {
		return message.includes(`failed to find element matching selector`);
	}
}
