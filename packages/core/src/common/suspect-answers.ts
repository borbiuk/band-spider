/**
 * An answer that can mean a problem of the page or a problem of the proxy:
 * - `notFound`: HTTP 404, the page may be gone or the IP may be blocked;
 * - `connection`: a network error, a timeout, HTTP 403 or 5xx, or a page that is not the expected one.
 */
export type SuspectKind = 'notFound' | 'connection';

/** One suspect answer that waits for a confirmation. */
export interface HeldAnswer<T> {
	item: T;
	kind: SuspectKind;
	/** When it came, in ms. */
	at: number;
	/** True when a page was read shortly before it. */
	readBefore: boolean;
}

/** When a control request is due for one kind: more than `minCount` such answers and more than `minShare` of all answers. */
export interface CheckRule {
	minCount: number;
	minShare: number;
}

export interface SuspectAnswersOptions {
	/** A suspect answer is confirmed by pages read this short time before and after it. */
	confirmWindowMs?: number;
	rules?: Record<SuspectKind, CheckRule>;
	/** Current time in ms. */
	now?: () => number;
}

/** A page read before and after a suspect answer confirms it when both are in this time. */
export const CONFIRM_WINDOW_MS = 60_000;

/**
 * 404 is 2-4% of the answers, but much more in old parts of the queue, so its rule is loose.
 * Network errors are about 0.01% when the proxy works, so a few of them are already strange.
 */
export const CHECK_RULES: Record<SuspectKind, CheckRule> = {
	notFound: { minCount: 100, minShare: 0.1 },
	connection: { minCount: 20, minShare: 0.05 },
};

/**
 * Keeps the suspect answers of one proxy until it is clear whether the proxy worked.
 *
 * A suspect answer is confirmed (it is about the page) when pages were read shortly before and
 * after it: then the proxy worked around it. Otherwise it waits for a control request. A control
 * request is due when an answer can no longer be confirmed by pages, or when one kind of suspect
 * answers is too frequent. The counts start again after each control request.
 */
export class SuspectAnswers<T> {
	private readonly confirmWindowMs: number;
	private readonly rules: Record<SuspectKind, CheckRule>;
	private readonly now: () => number;

	private held: HeldAnswer<T>[] = [];
	private lastReadAt: number | undefined;
	private answers = 0;
	private counts: Record<SuspectKind, number> = { notFound: 0, connection: 0 };

	constructor(options: SuspectAnswersOptions = {}) {
		this.confirmWindowMs = options.confirmWindowMs ?? CONFIRM_WINDOW_MS;
		this.rules = options.rules ?? CHECK_RULES;
		this.now = options.now ?? Date.now;
	}

	/** How many answers wait. */
	public get heldCount(): number {
		return this.held.length;
	}

	/** The kind of the oldest held answer, or undefined when none waits. */
	public get oldestKind(): SuspectKind | undefined {
		return this.held[0]?.kind;
	}

	/** Keeps a suspect answer until it is confirmed or dropped. */
	public hold(item: T, kind: SuspectKind): void {
		const at = this.now();
		this.answers++;
		this.counts[kind]++;
		this.held.push({ item, kind, at, readBefore: this.lastReadAt !== undefined && at - this.lastReadAt <= this.confirmWindowMs });
	}

	/**
	 * A page was answered as expected: read, or failed for a reason of the page itself. It shows the
	 * proxy works now.
	 *
	 * @returns The held answers that it confirms.
	 */
	public reportRead(): HeldAnswer<T>[] {
		const now = this.now();
		this.answers++;
		this.lastReadAt = now;
		const confirmed = this.held.filter(answer => answer.readBefore && now - answer.at <= this.confirmWindowMs);
		this.held = this.held.filter(answer => !confirmed.includes(answer));
		return confirmed;
	}

	/** An answer that says nothing about the proxy, like HTTP 429. It counts only as an answer. */
	public reportOther(): void {
		this.answers++;
	}

	/** The kind that makes a control request due now, or undefined when none is due. */
	public checkDue(): SuspectKind | undefined {
		const now = this.now();
		// pages can no longer confirm an answer that waits longer than the window. An answer with no
		// page before it can never be confirmed by pages, but it waits too, so one request checks many.
		const stuck = this.held.find(answer => now - answer.at > this.confirmWindowMs);
		if (stuck) {
			return stuck.kind;
		}
		for (const kind of ['connection', 'notFound'] as const) {
			const rule = this.rules[kind];
			if (this.counts[kind] > rule.minCount && this.counts[kind] / this.answers > rule.minShare) {
				return kind;
			}
		}
		return undefined;
	}

	/** Ends a control request: gives all held answers and starts the counts again. */
	public takeAll(): HeldAnswer<T>[] {
		const all = this.held;
		this.held = [];
		this.answers = 0;
		this.counts = { notFound: 0, connection: 0 };
		return all;
	}
}
