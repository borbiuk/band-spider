import 'reflect-metadata';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { HttpClient, ItemPageData, PageReader } from '@band-spider/core';
import { startDbService } from '@band-spider/db-service';
import { BandDatabase } from '@band-spider/storage-sqlite';
import { collectMetrics, CrawlerEvent, emptyCounts, runCrawler } from '../index';

describe('collectMetrics', () => {
	it('adds up the workers and takes the longest pause', () => {
		const metrics = collectMetrics(
			[
				{ requestCount: 5, rateLimitedCount: 1, pauseLeftMs: 0 },
				{ requestCount: 7, rateLimitedCount: 2, pauseLeftMs: 12_000 },
				{ requestCount: 1, rateLimitedCount: 0, pauseLeftMs: 3_000 },
			],
			{ ...emptyCounts(), claimed: 9, saved: 6, failed: 2, notFound: 1, rateLimited: 3 },
		);

		assert.deepEqual(metrics, { requests: 13, http429: 3, processed: 6, failed: 3, pauseMs: 12_000 });
	});

	it('is all zero without workers', () => {
		assert.deepEqual(collectMetrics([], emptyCounts()), { requests: 0, http429: 0, processed: 0, failed: 0, pauseMs: 0 });
	});
});

describe('crawler metrics event', () => {
	it('counts the requests of the workers and sends the metrics before it stops', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'band-spider-metrics-'));
		const file = path.join(dir, 'metrics.sqlite');
		const service = await startDbService({ host: '127.0.0.1', port: 0, database: { file, synchronize: true } });
		const seed = await BandDatabase.open({ file, synchronize: false });
		const target = http.createServer((_request, response) => response.end('page'));
		await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve));
		const targetPort = (target.address() as import('node:net').AddressInfo).port;
		try {
			for (const n of [1, 2, 3]) {
				await seed.item.insert(`https://metrics.bandcamp.com/track/${n}`);
			}

			// every page read makes one request with the HTTP client of its worker
			const createReader = (client: HttpClient): PageReader => ({
				readItemPage: async url => {
					await client.get(`http://127.0.0.1:${targetPort}/page`);
					return {
						url,
						accounts: { data: [] },
						tags: { data: [] },
						releaseDate: { data: new Date('2024-03-01T00:00:00.000Z') },
						album: { data: null },
						tracks: { data: [] },
						imageUrl: { data: null },
						errors: [],
					} as ItemPageData;
				},
				readAccountPage: async () => { throw new Error('not used'); },
			});

			const events: CrawlerEvent[] = [];
			await runCrawler({
				dbUrl: service.url, type: 'item', reverse: false, workers: 2, minDelayMs: 0, maxDelayMs: 0,
			}, { createReader, onEvent: event => events.push(event), metricsIntervalMs: 3_600_000 });

			// the timer never fired, so the one metrics event is the one before `stopped`
			const metrics = events.filter(event => event.type === 'metrics');
			assert.equal(metrics.length, 1);
			assert.deepEqual(metrics[0], {
				type: 'metrics',
				metrics: { requests: 3, http429: 0, processed: 3, failed: 0, pauseMs: 0 },
			});
			assert.equal(events.at(-1)?.type, 'stopped');
			assert.equal(events.at(-2)?.type, 'metrics');
		} finally {
			target.closeAllConnections();
			await new Promise(resolve => target.close(resolve));
			await seed.close();
			await service.stop();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
