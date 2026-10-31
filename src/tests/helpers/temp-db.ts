import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Points the app to a new DB file in a temp folder. `src/data/db.ts` reads the path when it is
 * loaded, so a test file must import this module before anything that loads the DB code.
 */
export const tempDbDir: string = fs.mkdtempSync(path.join(os.tmpdir(), 'band-spider-test-'));
export const tempDbFile: string = path.join(tempDbDir, 'test.sqlite');

process.env.BAND_DB_PATH = tempDbFile;
delete process.env.DB_SYNCHRONIZE;

export const removeTempDb = (): void => fs.rmSync(tempDbDir, { recursive: true, force: true });
