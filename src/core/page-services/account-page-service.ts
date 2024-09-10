import { ElementHandle, Page } from 'puppeteer';
import { isAccountUrl, isItemUrl, isNullOrUndefined, isValidUrl, originalUrl } from '../../common/utils';

export class AccountPageService {

	public async readAllAccountItems(page: Page): Promise<{ totalCount: number, itemsUrls: string[] }> {
		const totalCount = await this.getCollectionCount(page);

		// show all album or tracks
		if (totalCount > 40) {
			const showAllButton = await page.$('.collection-items > .expand-container.show-button > .show-more');
			if (!isNullOrUndefined(showAllButton)) {
				await showAllButton.click();
				await this.scrollToEnd(page);
			}
		}

		const urls = (await this.readHrefs(page, '.item-link'))
			.filter(x => isItemUrl(x))
			.map(x => originalUrl(x));

		// read all album or tracks urls
		return {
			totalCount: isNullOrUndefined(totalCount) || isNaN(totalCount) ? urls.length : totalCount,
			itemsUrls: urls
		};
	}

	private async getCollectionCount(page: Page): Promise<number> {
		try {
			const count = await page.$eval('li[data-tab="collection"] .count', element => element.textContent.trim());
			return Number(count);
		} catch {
			return null;
		}
	}

	public async readAllFollowers(page: Page): Promise<{ totalCount: number, accountUrls: string[] }> {
		try {
			// open followers
			const followersButton = await page.$('[data-grid-id="followers-grid"]');
			if (isNullOrUndefined(followersButton)) {
				return { totalCount: 0, accountUrls: [] };
			}
			await followersButton.click();

			const container = await page.$('#followers-container');

			const followersCount = await page.$eval(
				'li[data-grid-id="followers-grid"] .count',
				el => parseInt(el.textContent.trim())
			);

			// scroll to end
			if (followersCount > 40) {
				const showAllButton = await container.$('.show-more');
				if (!isNullOrUndefined(showAllButton) && await showAllButton.isVisible()) {
					await showAllButton.click();
					await this.scrollFollowersToEnd(page, container);
				}
			}

			// read URLs
			const urls = (await this.readHrefs(container, '.fan-info-inner a.fan-username'))
				.filter(x => isAccountUrl(x));

			return {
				totalCount: followersCount,
				accountUrls: urls
			}
		} catch (e) {
			return { totalCount: 0, accountUrls: [] };
		}
	}

	public async readAllFollowing(page: Page): Promise<{ totalCount: number, accountUrls: string[] }> {
		try {
			// open following
			const followingButton = await page.$('[data-grid-id="following-grid"]');
			if (isNullOrUndefined(followingButton)) {
				return { totalCount: 0, accountUrls: [] };
			}
			await followingButton.click();
			const fansButton = await page.$('[data-grid-id="following-fans-container"]');
			if (isNullOrUndefined(fansButton)) {
				return { totalCount: 0, accountUrls: [] };
			}
			await fansButton.click();

			const container = await page.$('#following-fans-container');

			const followingCount = await page.$eval(
				'li[data-grid-id="following-fans-container"] .count',
				el => parseInt(el.textContent.trim())
			);

			// scroll to end
			if (followingCount > 45) {
				const showAllButton = await container.$('.show-more');
				if (!isNullOrUndefined(showAllButton) && await showAllButton.isVisible()) {
					await showAllButton.click();
					await this.scrollFollowersToEnd(page, container);
				}
			}

			// read URLs
			const urls = (await this.readHrefs(container, '.fan-info-inner a.fan-username'))
				.filter(x => isAccountUrl(x));

			return {
				totalCount: followingCount,
				accountUrls: urls
			}
		} catch (e) {
			return { totalCount: 0, accountUrls: [] };
		}
	}

	private async scrollToEnd(page: Page): Promise<void> {
		const container = await page.$('.fan-container');
		if (isNullOrUndefined(container)) {
			return;
		}

		let isLoadingAvailable = true;
		let height = (await container.boundingBox()).height;
		let retry = 0;

		while (isLoadingAvailable && retry < 2) {
			try {
				// scroll to end
				await page.evaluate((height: number) => {
					window.scrollTo(0, height * 10);
				}, height);

				// wait on loader
				await page.waitForSelector('#collection-items .expand-container:not(.show-loading)', { timeout: 700 });

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

	private async scrollFollowersToEnd(page: Page, container: ElementHandle): Promise<void> {
		if (isNullOrUndefined(container)) {
			return;
		}

		let isLoadingAvailable = true;
		let height = (await container.boundingBox()).height;
		let retry = 0;

		while (isLoadingAvailable && retry < 2) {
			try {
				// scroll to end
				await page.evaluate((height: number) => {
					window.scrollTo(0, height * 10);
				}, height);

				// wait on loader
				await container.waitForSelector('#loading-new-items svg.upload-spinner', { timeout: 700 });

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

	private async readHrefs(page: Page | ElementHandle, selector: string): Promise<string[]> {
		return await page.$$eval(selector, (elements: HTMLAnchorElement[]) =>
			elements.map((element) => element.href)
		);
	}
}
