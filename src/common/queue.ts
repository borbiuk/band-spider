import { onlyUnique } from './utils';

export class Queue {

	constructor(
		private readonly array: string[] = [],
	) {
		this.array = array.filter(onlyUnique);
	}

	public enqueue(item: string): boolean {
		if (this.array.includes(item)) {
			return false;
		}

		this.array.push(item);

		return true;
	}

	public enqueueButch(butch: string[]): void {
		butch.forEach(x => {
			this.enqueue(x);
		});
	}

	public dequeue(): string {
		return this.array.shift();
	}

	public get size(): number {
		return this.array.length;
	}
}
