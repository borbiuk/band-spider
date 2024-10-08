import { Page } from 'puppeteer';
import { followerColor, itemColor, logger, LogSource } from '../../common/logger';
import { QueueEvent } from '../../common/processing-queue';
import { logMessage, minus, yesNo } from '../../common/utils';
import { BandDatabase } from '../../data/db';
import { saveAccountPageData } from './clients/account-db-client';
import { readAccountPage } from './clients/account-page-client';
import { AccountPageData } from './models/account-page-data';
import { AccountPageStatistic } from './models/account-page-statistic';
import { AccountTabStatistic } from './models/account-tab-statistic';

export async function processAccount(
	{ id, url }: QueueEvent,
	database: BandDatabase,
	page: Page,
	pageIndex: number,
): Promise<boolean> {

	// read data from the page
	let accountPageData: AccountPageData
	try {
		accountPageData = await readAccountPage(url, page);
		if (accountPageData.errors.length > 0) {
			accountPageData.errors.forEach((e: Error) => {
				logger.warn(logMessage(LogSource.Account, 'Scrapping issue', url), e);
			});
		}
	} catch (e) {
		logger.error(e, logMessage(LogSource.Account, 'Scrapping failed!', url));
		return false;
	}

	// save data
	let accountPageStatistic: AccountPageStatistic;
	try {
		accountPageStatistic = await saveAccountPageData(id, accountPageData, database);
	} catch (e) {
		logger.error(e, logMessage(LogSource.Account, 'Data saving failed!', url));
		return false;
	}

	logAccountPageStatistic(url, pageIndex, accountPageStatistic);

	return true;
}

function logAccountPageStatistic(
	url: string,
	pageIndex: number,
	{ collection, wishlist, followers, following }: AccountPageStatistic
): void {
	const collectionStat = itemColor(accountTabStatisticMessage(collection));
	const wishlistStat = itemColor(accountTabStatisticMessage(wishlist));
	const followersStat = followerColor(accountTabStatisticMessage(followers));
	const followingStat = followerColor(accountTabStatisticMessage(following));

	const message = `[${String(pageIndex).padEnd(2)}] Account finished: ${collectionStat} ${wishlistStat} ${followersStat} ${followingStat}`;

	logger.info(
		logMessage(LogSource.Account, message, url)
	);
}

function accountTabStatisticMessage({ allScraped, newRecords, newRelations, total }: AccountTabStatistic): string {
	return `${minus(newRecords).padStart(4)}/${minus(total).padEnd(4)}[${yesNo(allScraped)}] ${minus(newRelations).padEnd(4)}`;
}
