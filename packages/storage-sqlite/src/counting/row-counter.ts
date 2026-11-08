import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { ProcessingHistoryCounts, RowCounts } from './count-queries';

/** Counts the rows of the DB. The counts of a big DB take seconds, so a real one runs off the main thread. */
export interface RowCounter {
	queueLeft(): Promise<{ items: number, accounts: number }>;
	rows(): Promise<RowCounts>;
	processingHistory(): Promise<ProcessingHistoryCounts>;
	close(): Promise<void>;
}

type Pending = { resolve(value: any): void, reject(error: Error): void };

/**
 * Counts in a worker thread with its own read-only connection. In WAL mode a reader does not block
 * the writer, and the main thread stays free while the worker scans the tables.
 */
export class WorkerRowCounter implements RowCounter {
	private worker: Worker | undefined;
	private readonly pending = new Map<number, Pending>();
	private nextId = 0;

	constructor(private readonly file: string) {
	}

	public queueLeft(): Promise<{ items: number, accounts: number }> {
		return this.ask('queueLeft');
	}

	public rows(): Promise<RowCounts> {
		return this.ask('rows');
	}

	public processingHistory(): Promise<ProcessingHistoryCounts> {
		return this.ask('processingHistory');
	}

	public async close(): Promise<void> {
		const worker = this.worker;
		this.worker = undefined;
		this.failAll(new Error('The row counter is closed'));
		await worker?.terminate();
	}

	private ask<T>(kind: 'queueLeft' | 'rows' | 'processingHistory'): Promise<T> {
		const worker = this.worker ?? this.start();
		return new Promise<T>((resolve, reject) => {
			const id = this.nextId++;
			this.pending.set(id, { resolve, reject });
			worker.postMessage({ id, kind });
		});
	}

	private start(): Worker {
		const worker = new Worker(path.join(__dirname, 'count-worker.js'), { workerData: { file: this.file } });
		worker.on('message', ({ id, value, error }: { id: number, value?: unknown, error?: string }) => {
			const pending = this.pending.get(id);
			this.pending.delete(id);
			if (error !== undefined) {
				pending?.reject(new Error(error));
			} else {
				pending?.resolve(value);
			}
		});
		// a dead worker fails what waits for it; the next ask starts a new one
		const lost = (error: Error): void => {
			if (this.worker === worker) {
				this.worker = undefined;
			}
			this.failAll(error);
		};
		worker.on('error', lost);
		worker.on('exit', code => lost(new Error(`The row counter stopped with code ${code}`)));
		// an idle worker must not keep the process alive
		worker.unref();
		this.worker = worker;
		return worker;
	}

	private failAll(error: Error): void {
		for (const pending of this.pending.values()) {
			pending.reject(error);
		}
		this.pending.clear();
	}
}
