import { Page } from 'puppeteer';
import { HttpClient } from '../common/http-client';
import { AccountPageData } from './account/models/account-page-data';
import { readAccountPageByFetch } from './account/clients/account-fetch-client';
import { readAccountPage } from './account/clients/account-page-client';
import { readItemPageByFetch } from './item/clients/item-fetch-client';
import { readItemPage } from './item/clients/item-page-client';
import { ItemPageData } from './item/models/item-page-data';

/** Reads the data of Bandcamp pages. The handlers do not care how the page is loaded. */
export interface PageReader {
	readItemPage(url: string): Promise<ItemPageData>;
	readAccountPage(url: string): Promise<AccountPageData>;
}

/** Plain HTTP requests, no browser. The default. */
export class FetchPageReader implements PageReader {
	constructor(private readonly http: HttpClient) {
	}

	public readItemPage(url: string): Promise<ItemPageData> {
		return readItemPageByFetch(url, this.http);
	}

	public readAccountPage(url: string): Promise<AccountPageData> {
		return readAccountPageByFetch(url, this.http);
	}
}

/** Puppeteer. Used with the `--browser` flag. The page is replaced from time to time. */
export class BrowserPageReader implements PageReader {
	constructor(private page: Page) {
	}

	/** Reads the next pages with this one. */
	public replace(page: Page): void {
		this.page = page;
	}

	public readItemPage(url: string): Promise<ItemPageData> {
		return readItemPage(url, this.page);
	}

	public readAccountPage(url: string): Promise<AccountPageData> {
		return readAccountPage(url, this.page);
	}
}

/** What a worker reads pages with, and what it does around it. */
export interface PageSource {
	reader: PageReader;
	/** Called after every processed URL. The browser source replaces its page and browser here. */
	afterUrl: () => Promise<void>;
	close: () => Promise<void>;
}
