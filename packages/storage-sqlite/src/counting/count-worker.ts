import { parentPort, workerData } from 'node:worker_threads';
import { countQueueLeft, countRows, CountConnection } from './count-queries';

/** The thread of the counts: its own read-only connection, so a count that takes seconds blocks only this thread. */
const Database = require('better-sqlite3') as new (file: string, options: { readonly: boolean }) => CountConnection;
const connection = new Database((workerData as { file: string }).file, { readonly: true });

parentPort?.on('message', ({ id, kind }: { id: number, kind: 'queueLeft' | 'rows' }) => {
	try {
		parentPort?.postMessage({ id, value: kind === 'queueLeft' ? countQueueLeft(connection) : countRows(connection) });
	} catch (error) {
		parentPort?.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
	}
});
