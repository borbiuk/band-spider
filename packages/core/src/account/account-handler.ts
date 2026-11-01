import { errorMessage } from '../common/errors';
import { followerColor, itemColor, logger, LogSource } from '../common/logger';
import { RateLimitedError } from '../common/rate-limit-gate';
import { logMessage, minus, yesNo } from '../common/utils';
import type { CrawlStore, CrawlTask } from '../crawl-store';
import { PageReader } from '../page-reader';
import { AccountPageData } from './models/account-page-data';
import { AccountPageStatistic } from './models/account-page-statistic';
import { AccountTabStatistic } from './models/account-tab-statistic';

export async function processAccount(
	task: CrawlTask,
	store: CrawlStore,
	reader: PageReader,
	pageIndex: number,
): Promise<boolean> {
	// tabs that were read to their end before are read only up to their newest records
	const { url, marks = {} } = task;

	// read data from the page
	let accountPageData: AccountPageData
	try {
		accountPageData = await reader.readAccountPage(url, marks);
	} catch (e) {
		if (e instanceof RateLimitedError) {
			throw e;
		}
		logger.error(logMessage(LogSource.Account,  `[${String(pageIndex).padEnd(2)}] Scrapping failed: ${errorMessage(e)}`, url));
		return false;
	}

	// save data
	let accountPageStatistic: AccountPageStatistic;
	try {
		accountPageStatistic = await store.saveAccount(task, accountPageData);
	} catch (e) {
		logger.error(e, logMessage(LogSource.Account, `[${String(pageIndex).padEnd(2)}] Data saving failed: ${errorMessage(e)}`, url));
		return false;
	}

	logAccountPageStatistic(url, pageIndex, accountPageStatistic);
	const stopped = (['collection', 'wishlist', 'followers', 'following'] as const).filter(tab => accountPageData[tab].stoppedAtMark);
	if (stopped.length !== 0) {
		logger.debug(logMessage(LogSource.Account, `[${String(pageIndex).padEnd(2)}] Read up to the saved records: ${stopped.join(', ')}`, url));
	}

	const result = accountPageData.errors.length === 0;
	if (!result) {
		accountPageData.errors.forEach((e: Error) => {
			logger.warn(logMessage(LogSource.Account, `[${String(pageIndex).padEnd(2)}] Scrapping issue: ${e.message}`, url));
		});
	}
	return result;
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

	const message = `[${String(pageIndex).padEnd(2)}] ${collectionStat} ${wishlistStat} ${followersStat} ${followingStat}`;

	logger.info(
		logMessage(LogSource.Account, message, url)
	);
}

function accountTabStatisticMessage({ allScraped, newRecords, newRelations, total }: AccountTabStatistic): string {
	return `${minus(newRecords).padStart(4)}/${minus(total).padEnd(4)}[${yesNo(allScraped)}] ${minus(newRelations).padEnd(4)}`;
}
