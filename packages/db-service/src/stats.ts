import type { StatsResponse } from '@band-spider/contracts';

/** Counters since the service started. They are kept in memory only. */
export class ServiceStats {
	private readonly startedAt: Date;
	private claimed = 0;
	private itemsSaved = 0;
	private accountsSaved = 0;
	private released = 0;
	private newUrls = 0;

	constructor(now: () => Date = () => new Date()) {
		this.startedAt = now();
	}

	public onClaimed(count: number): void {
		this.claimed += count;
	}

	public onItemSaved(newUrls: number): void {
		this.itemsSaved++;
		this.newUrls += newUrls;
	}

	public onAccountSaved(newUrls: number): void {
		this.accountsSaved++;
		this.newUrls += newUrls;
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
		};
	}
}
