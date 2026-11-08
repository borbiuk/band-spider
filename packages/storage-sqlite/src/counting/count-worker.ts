import { parentPort, workerData } from 'node:worker_threads';
import { countProcessingHistory, countQueueLeft, countRows, CountConnection } from './count-queries';

/** The thread of the counts: its own read-only connection, so a count that takes seconds blocks only this thread. */
const Database = require('better-sqlite3') as new (file: string, options: { readonly: boolean }) => CountConnection;
const connection = new Database((workerData as { file: string }).file, { readonly: true });

const counts = { queueLeft: countQueueLeft, rows: countRows, processingHistory: countProcessingHistory };

parentPort?.on('message', ({ id, kind }: { id: number, kind: keyof typeof counts }) => {
	try {
		parentPort?.postMessage({ id, value: counts[kind](connection) });
	} catch (error) {
		parentPort?.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
	}
});
