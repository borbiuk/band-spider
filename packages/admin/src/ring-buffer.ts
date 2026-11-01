/** Keeps the last lines of a child's output. Text arrives in chunks, so a partial line waits for its end. */
export class LogRingBuffer {
	private readonly lines: string[] = [];
	private partial = '';

	constructor(private readonly capacity = 500) {
	}

	append(text: string): void {
		const parts = (this.partial + text).split(/\r?\n/);
		this.partial = parts.pop() ?? '';
		for (const line of parts) {
			this.lines.push(line);
		}
		if (this.lines.length > this.capacity) {
			this.lines.splice(0, this.lines.length - this.capacity);
		}
	}

	/** The last lines, oldest first. The line that is not finished yet is included. */
	snapshot(limit = this.capacity): string[] {
		const all = this.partial ? [...this.lines, this.partial] : this.lines;
		return all.slice(-limit);
	}
}
