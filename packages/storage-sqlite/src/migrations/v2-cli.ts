import 'reflect-metadata';
import { checkV2, migrateToV2 } from './v2';

/**
 * Builds a v2 DB from a DB with the old schema, then checks it. The old file is only read.
 * Stop the DB service before, and point it at the new file after. See docs/db-schema-migration.md.
 *
 * Usage: node dist/migrations/v2-cli.js <old file> <new file> [--skip-checks]
 */
async function main(): Promise<void> {
	const [oldFile, newFile] = process.argv.slice(2).filter(x => !x.startsWith('--'));
	if (!oldFile || !newFile) {
		console.error('Usage: v2-cli <old file> <new file> [--skip-checks]');
		process.exit(2);
	}

	const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);
	const started = Date.now();
	const report = await migrateToV2(oldFile, newFile, { log });
	log(`migrated in ${((Date.now() - started) / 60_000).toFixed(1)} min`);
	console.log(JSON.stringify({ rows: report.rows, merged: report.merged, droppedItems: report.droppedItems }, null, '\t'));

	if (process.argv.includes('--skip-checks')) {
		return;
	}
	const { integrity, foreignKeys } = checkV2(newFile, { log });
	if (integrity.length !== 0 || foreignKeys.length !== 0) {
		console.error(JSON.stringify({ integrity: integrity.slice(0, 20), foreignKeys: foreignKeys.slice(0, 20) }, null, '\t'));
		process.exit(1);
	}
	log('checks passed');
}

main().catch(error => {
	console.error(error);
	process.exit(1);
});
