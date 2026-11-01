import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

// tests run from `packages/core/dist/tests`, the sources stay in `packages/core/src`
const CORE_DIR = path.join(__dirname, '../..');
const STORAGE_PACKAGES = ['typeorm', 'better-sqlite3', '@band-spider/storage-sqlite'];

const sourceFiles = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
	const full = path.join(dir, entry.name);
	return entry.isDirectory() ? sourceFiles(full) : full.endsWith('.ts') ? [full] : [];
});

describe('core package boundary', () => {
	it('does not import the storage packages in its sources', () => {
		// this file lists the package names, so it is not checked
		for (const file of sourceFiles(path.join(CORE_DIR, 'src')).filter(file => !file.endsWith('package-boundary.test.ts'))) {
			const text = fs.readFileSync(file, 'utf8');
			for (const name of STORAGE_PACKAGES) {
				assert.ok(!text.includes(`'${name}'`), `${path.relative(CORE_DIR, file)} imports ${name}`);
			}
		}
	});

	it('does not list the storage packages as dependencies', () => {
		const packageJson = JSON.parse(fs.readFileSync(path.join(CORE_DIR, 'package.json'), 'utf8'));
		const dependencies = Object.keys({ ...packageJson.dependencies, ...packageJson.devDependencies });
		for (const name of STORAGE_PACKAGES) {
			assert.ok(!dependencies.includes(name), `core depends on ${name}`);
		}
	});
});
