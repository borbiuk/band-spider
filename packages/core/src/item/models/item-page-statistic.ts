import { ItemTabStatistic } from './item-tab-statistic';

export interface ItemPageStatistic {
	accounts: ItemTabStatistic,
	tags: ItemTabStatistic,
	releaseDate: ItemTabStatistic,
	album: ItemTabStatistic,
	tracks: ItemTabStatistic,
	/** URLs (accounts, album, tracks) that did not exist in the database before this page was saved. */
	newUrls: string[],
}
