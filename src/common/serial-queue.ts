/** Runs async jobs one at a time, in the order they were added. */
export class SerialQueue {
	private tail: Promise<unknown> = Promise.resolve();

	public run<T>(job: () => Promise<T>): Promise<T> {
		const result = this.tail.then(job);
		// a failed job must not block the next ones
		this.tail = result.catch(() => { });
		return result;
	}
}
