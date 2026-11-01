import type { AccountPageStatisticDto, FlowStats, ItemPageStatisticDto, StatsResponse, TabFlow } from '@band-spider/contracts';

const emptyTab = (): TabFlow => ({ total: 0, newRecords: 0, newRelations: 0 });

const addTab = (sum: TabFlow, tab: TabFlow): void => {
	sum.total += tab.total;
	sum.newRecords += tab.newRecords;
	sum.newRelations += tab.newRelations;
};

const emptyFlow = (): FlowStats => ({
	itemPages: { saved: 0, accounts: emptyTab(), tags: emptyTab(), album: emptyTab(), tracks: emptyTab() },
	accountPages: { saved: 0, collection: emptyTab(), wishlist: emptyTab(), followers: emptyTab(), following: emptyTab() },
});

/** Counters since the service started. They are kept in memory only. */
export class ServiceStats {
	private readonly startedAt: Date;
	private claimed = 0;
	private itemsSaved = 0;
	private accountsSaved = 0;
	private released = 0;
	private newUrls = 0;
	private readonly flow = emptyFlow();

	constructor(now: () => Date = () => new Date()) {
		this.startedAt = now();
	}

	public onClaimed(count: number): void {
		this.claimed += count;
	}

	/** The statistic of the saved page is optional, so a caller that has only the URL count still works. */
	public onItemSaved(newUrls: number, statistic?: ItemPageStatisticDto): void {
		this.itemsSaved++;
		this.newUrls += newUrls;
		const pages = this.flow.itemPages;
		pages.saved++;
		if (statistic) {
			addTab(pages.accounts, statistic.accounts);
			addTab(pages.tags, statistic.tags);
			addTab(pages.album, statistic.album);
			addTab(pages.tracks, statistic.tracks);
		}
	}

	public onAccountSaved(newUrls: number, statistic?: AccountPageStatisticDto): void {
		this.accountsSaved++;
		this.newUrls += newUrls;
		const pages = this.flow.accountPages;
		pages.saved++;
		if (statistic) {
			addTab(pages.collection, statistic.collection);
			addTab(pages.wishlist, statistic.wishlist);
			addTab(pages.followers, statistic.followers);
			addTab(pages.following, statistic.following);
		}
	}

	public onReleased(): void {
		this.released++;
	}

	public snapshot(): StatsResponse {
		return {
			startedAt: this.startedAt,
			claimed: this.claimed,
			itemsSaved: this.itemsSaved,
			accountsSaved: this.accountsSaved,
			released: this.released,
			newUrls: this.newUrls,
			// a copy, so a caller cannot change the counters
			flow: structuredClone(this.flow),
		};
	}
}
