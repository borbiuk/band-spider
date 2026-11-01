import { HttpClient } from '../common/http-client';
import { RateLimitGate } from '../common/rate-limit-gate';
import { AccountScanMarks } from '../models/account-scan-marks';
import { AccountPageData } from './account/models/account-page-data';
import { readAccountPageByFetch } from './account/clients/account-http-reader';
import { readItemPageByFetch } from './item/clients/item-http-reader';
import { ItemPageData } from './item/models/item-page-data';

/** Reads the data of Bandcamp pages. The handlers do not care how the page is loaded. */
export interface PageReader {
	readItemPage(url: string): Promise<ItemPageData>;
	/** @param marks - Where the last complete read of each tab began; see `buildAccountPageData`. */
	readAccountPage(url: string, marks?: AccountScanMarks): Promise<AccountPageData>;
}

/** Plain HTTP requests. */
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

/** What a worker reads pages with, and what it does around it. */
export interface PageSource {
	reader: PageReader;
	/** The 429 pause of this worker. */
	rateLimitGate: RateLimitGate;
	/** Called after every processed URL. */
	afterUrl: () => Promise<void>;
	close: () => Promise<void>;
}
