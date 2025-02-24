import { Page } from 'puppeteer';
import {
	delay,
	isAccountUrl,
	isAlbumUrl,
	isEmptyString,
	isNullOrUndefined,
	isTrackUrl,
	isValidDate,
	isValidUrl,
	onlyUnique,
	originalUrl
} from '../../../common/utils';
import { ProxyClient } from '../../proxy/proxy-client';
import { ItemPageData } from '../models/item-page-data';
import { defaultItemTabData, errorItemData, ItemTabData } from '../models/item-tab-data';

export async function readItemPage(
	url: string,
	page: Page,
): Promise<ItemPageData> {
	try {
		await page.goto(url, { timeout: 3_500, waitUntil: 'domcontentloaded' })

		const errorTitle: boolean = await page
			.$eval('h2', (element) => {
				return element.textContent.trim() === 'Sorry, that something isn’t here.';
			})
			.catch(() => false);

		if (errorTitle) {
			throw new Error('Page did not exist');
		}

	} catch (e) {
		if (e.message.includes('Navigation timeout')) {
			await ProxyClient.initialize.changeIp();
		}

		throw e;
	}

	const accounts = await readAllPageAccounts(page);
	const tags = await readAllPageTags(page);
	const releaseDate = await readItemReleaseDate(page);

	const album = isTrackUrl(url)
		? await readTrackAlbum(page, url)
		: defaultItemTabData<string>();
	const tracks = isAlbumUrl(url)
		? await readAllAlbumTracks(page, url)
		: defaultItemTabData<string[]>();

	const imageUrl = await readItemImage(page, url);

	return {
		url,
		accounts,
		tags,
		releaseDate,
		album,
		tracks,
		imageUrl,
		errors: [accounts.error, tags.error, releaseDate.error, album.error, tracks.error, imageUrl.error].filter(x => !isNullOrUndefined(x))
	};
}

/**
 * Retrieves account URLs from a page.
 * This function clicks on a button to load more accounts on the page, and then extracts the URLs of the loaded accounts.
 * If loading more accounts fails, it retries a specified number of times with a delay between retries.
 * @param page - The Puppeteer page from which to retrieve account URLs.
 * @returns A Promise resolving to an array of account URLs.
 */
async function readAllPageAccounts(page: Page): Promise<ItemTabData<string[]>> {
	try {
		let accounts = await getPageAccounts(page);

		// TODO: button click did not working in headless mode
		// if (accounts.length === 60) {
		// 	await loadAllAccount(page);
		// 	accounts = await getPageAccounts(page);
		// }

		const urls = accounts
			.map(x => originalUrl(x))
			.filter(x => isAccountUrl(x));

		return { data: urls, };
	} catch (e) {
		return errorItemData(e);
	}
}

async function getPageAccounts(page: Page): Promise<string[]> {
	return await page.$$eval('a.fan.pic', (elements) => elements.map(x => x.getAttribute('href')));
}

async function loadAllAccount(page: Page): Promise<void> {
	while (true) {
		try {
			const showMoreAccountsButton = await page.$('a.more-thumbs');
			if (isNullOrUndefined(showMoreAccountsButton)) {
				break;
			}
			await showMoreAccountsButton?.click();
			await delay();
		} catch {
			break;
		}
	}
}

async function readAllPageTags(page: Page): Promise<ItemTabData<string[]>> {
	const tags = await page
		.$$eval('a.tag', tags => tags.map(x => x.textContent.trim()))
		.catch((error) => error);

	if (tags instanceof Error) {
		return errorItemData(tags);
	}

	return { data: tags };
}

async function readItemReleaseDate(page: Page): Promise<ItemTabData<Date>> {
	const content = await page
		.$eval(
			'.tralbumData.tralbum-credits',
			element => element.textContent
		)
		.catch((error) => {
			return error;
		});

	if (content instanceof Error) {
		return errorItemData(content);
	}
	if (isNullOrUndefined(content)) {
		return defaultItemTabData();
	}

	const match = content.match(/(?:released|releases) (\w+ \d{1,2}, \d{4})/);
	if (isNullOrUndefined(match) || match.length <= 1 || isNullOrUndefined(match[1])) {
		return defaultItemTabData();
	}

	const date: Date = new Date(match[1]);
	return isValidDate(date)
		? { data: date }
		: defaultItemTabData();
}

async function readAllAlbumTracks(page: Page, url: string): Promise<ItemTabData<string[]>> {
	const { hostname, protocol } = new URL(url);
	const domain = protocol + '//' + hostname;

	const tracks: string[] = await page
		.$$eval(
			'table.track_list#track_table a',
			links => links.map(link => link.getAttribute('href'))
		)
		.catch(error => error);

	if (tracks instanceof Error) {
		return errorItemData(tracks);
	}

	const urls = tracks
		.filter(x => !isNullOrUndefined(x))
		.map(x => domain + originalUrl(x))
		.filter(x => isValidUrl(x))
		.filter(onlyUnique);

	return { data: urls };
}

async function readTrackAlbum(page: Page, url: string): Promise<ItemTabData<string>> {
	const { hostname, protocol } = new URL(url);
	const domain = protocol + '//' + hostname;

	const albumPath = await page
		.$eval(
			'#buyAlbumLink',
			element => element.getAttribute('href')
		)
		.catch((error) => error);

	if (albumPath instanceof Error) {
		return errorItemData(albumPath);
	}

	return isEmptyString(albumPath)
		? defaultItemTabData()
		: { data: domain + albumPath };
}

async function readItemImage(page: Page, url: string): Promise<ItemTabData<string>> {
	try {
		const imgUrl = await page.$eval(`#tralbumArt img`, (img) => img.src);
		return { data: imgUrl };
	}
	catch (e) {
		return errorItemData(e);
	}
}
