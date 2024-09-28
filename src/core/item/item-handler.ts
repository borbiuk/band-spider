import { Page } from 'puppeteer';
import { accountColor, albumColor, dateColor, itemColor, logger, LogSource, tagColor } from '../../common/logger';
import { QueueEvent } from '../../common/processing-queue';
import { logMessage, minus, yesNo } from '../../common/utils';
import { BandDatabase } from '../../data/db';
import { saveItemPageData } from './clients/item-db-client';
import { readItemPage } from './clients/item-page-client';
import { ItemPageData } from './models/item-page-data';
import { ItemPageStatistic } from './models/item-page-statistic';
import { ItemTabStatistic } from './models/item-tab-statistic';

export async function processItem(
	{ id, url }: QueueEvent,
	database: BandDatabase,
	page: Page,
	pageIndex: number,
): Promise<boolean> {

	// read data from the page
	let itemPageData: ItemPageData;
	try {
		itemPageData = await readItemPage(url, page);
		if (itemPageData.errors.length > 0) {
			itemPageData.errors.forEach((e: Error) => {
				logger.warn(logMessage(LogSource.Item, 'Scrapping issue', url), e);
			});
		}
	} catch (e) {
		throw e;
		logger.error(e, logMessage(LogSource.Item, 'Scrapping failed!', url));
		return false;
	}

	// save data
	let itemPageStatistic: ItemPageStatistic;
	try {
		itemPageStatistic = await saveItemPageData(id, itemPageData, database);
	} catch (e) {
		throw e;
		logger.error(e, logMessage(LogSource.Item, 'Data saving failed!', url));
		return false;
	}

	logItemPageStatistic(url, pageIndex, itemPageStatistic);

	return true;
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

	const message = `[${String(pageIndex).padEnd(2)}] Item finished: ${accountsStat} ${albumStat} ${tracksStat} ${releaseDateStat} ${tagsStat}`;

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
