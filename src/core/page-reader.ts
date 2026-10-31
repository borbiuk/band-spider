import type { Page } from 'puppeteer';
import { HttpClient } from '../common/http-client';
import { AccountScanMarks } from '../models/account-scan-marks';
import { AccountPageData } from './account/models/account-page-data';
import { readAccountPage } from './account/clients/account-browser-reader';
import { readAccountPageByFetch } from './account/clients/account-http-reader';
import { readItemPage } from './item/clients/item-browser-reader';
import { readItemPageByFetch } from './item/clients/item-http-reader';
import { ItemPageData } from './item/models/item-page-data';

/** Reads the data of Bandcamp pages. The handlers do not care how the page is loaded. */
export interface PageReader {
	readItemPage(url: string): Promise<ItemPageData>;
	/** @param marks - Where the last complete read of each tab began; see `buildAccountPageData`. */
	readAccountPage(url: string, marks?: AccountScanMarks): Promise<AccountPageData>;
}

/** Plain HTTP requests, no browser. The default. */
export class FetchPageReader implements PageReader {
	constructor(private readonly http: HttpClient) {
	}

	public readItemPage(url: string): Promise<ItemPageData> {
		return readItemPageByFetch(url, this.http);
	}

	public readAccountPage(url: string, marks?: AccountScanMarks): Promise<AccountPageData> {
		return readAccountPageByFetch(url, this.http, marks);
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

	public readAccountPage(url: string, marks?: AccountScanMarks): Promise<AccountPageData> {
		return readAccountPage(url, this.page, marks);
	}
}

/** What a worker reads pages with, and what it does around it. */
export interface PageSource {
	reader: PageReader;
	/** Called after every processed URL. The browser source replaces its page and browser here. */
	afterUrl: () => Promise<void>;
	close: () => Promise<void>;
}
