import { errorMessage, failureKey, FailureReport, FailureStage } from '../common/errors';
import { accountColor, albumColor, dateColor, itemColor, logger, LogSource, tagColor } from '../common/logger';
import { RateLimitedError } from '../common/rate-limit-gate';
import { logMessage, minus, yesNo } from '../common/utils';
import type { CrawlStore, CrawlTask } from '../crawl-store';
import { PageReader } from '../page-reader';
import { ItemPageData } from './models/item-page-data';
import { ItemPageStatistic } from './models/item-page-statistic';
import { ItemTabStatistic } from './models/item-tab-statistic';

export async function processItem(
	task: CrawlTask,
	store: CrawlStore,
	reader: PageReader,
	pageIndex: number,
	/** Called for each error that makes the URL fail: a failed read or save, and each issue of a page that was saved. */
	onFailure: (failure: FailureReport) => void = () => { },
): Promise<boolean> {
	const fail = (error: unknown, stage: FailureStage = 'scrape'): void =>
		onFailure({ key: failureKey(error, stage), message: errorMessage(error), url: task.url });
	const { url } = task;

	// read data from the page
	let itemPageData: ItemPageData;
	try {
		itemPageData = await reader.readItemPage(url);
	} catch (e) {
		if (e instanceof RateLimitedError) {
			throw e;
		}
		fail(e);
		logger.error(logMessage(LogSource.Item, `[${String(pageIndex).padEnd(2)}] Scrapping failed: ${errorMessage(e)}`.padEnd(61), url));
		return false;
	}

	// save data
	let itemPageStatistic: ItemPageStatistic;
	try {
		itemPageStatistic = await store.saveItem(task, itemPageData);
	} catch (e) {
		fail(e, 'save');
		logger.error(e, logMessage(LogSource.Item, `[${String(pageIndex).padEnd(2)}] saving failed: ${errorMessage(e)}`.padEnd(61), url));
		return false;
	}

	logItemPageStatistic(url, pageIndex, itemPageStatistic);

	const result = itemPageData.errors.length === 0;
	if (!result) {
		itemPageData.errors.forEach((e: Error) => {
			fail(e);
			logger.warn(logMessage(LogSource.Item, `[${String(pageIndex).padEnd(2)}] Scrapping issue: ${e.message}`.padEnd(61), url));
		});
	}

	return result;
}

function logItemPageStatistic(
	url: string,
	pageIndex: number,
	{ accounts, tags, releaseDate, album, tracks }: ItemPageStatistic
): void {

	const accountsStat = accountColor(itemTabStatisticMessage(accounts));
	const tagsStat = tagColor(itemTabStatisticMessage(tags));
	const releaseDateStat = dateColor(itemTabBooleanStatisticMessage(releaseDate));
	const albumStat = albumColor(itemTabBooleanStatisticMessage(album));
	const tracksStat = itemColor(itemTabStatisticMessage(tracks));

	const message = `[${String(pageIndex).padEnd(2)}] ${accountsStat} ${albumStat} ${tracksStat} ${releaseDateStat} ${tagsStat}`;

	logger.info(
		logMessage(LogSource.Item, message, url)
	);
}

function itemTabStatisticMessage({ newRecords, newRelations, total }: ItemTabStatistic): string {
	return `${minus(newRecords).padStart(4)}/${minus(total).padEnd(4)} ${minus(newRelations).padEnd(4)}`
}

function itemTabBooleanStatisticMessage({ newRecords, newRelations, total }: ItemTabStatistic): string {
	return `${yesNo(newRecords)}/${yesNo(total)} ${yesNo(newRelations)}`
}
