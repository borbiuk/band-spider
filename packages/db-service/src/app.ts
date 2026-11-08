import crypto from 'node:crypto';
import {
	claimRequestSchema,
	claimResponseSchema,
	controlUrlResponseSchema,
	errorResponseSchema,
	extendLeaseRequestSchema,
	extendLeaseResponseSchema,
	healthResponseSchema,
	releaseRequestSchema,
	releaseResponseSchema,
	saveAccountRequestSchema,
	saveAccountResponseSchema,
	saveItemRequestSchema,
	saveItemResponseSchema,
	processingHistoryResponseSchema,
	statsResponseSchema,
	totalsResponseSchema,
	type ProcessingHistoryResponse,
	type TotalsResponse,
} from '@band-spider/contracts';
import { CrawlStore, errorMessage, ReleaseReason, UrlType } from '@band-spider/core';
import Fastify, { FastifyError, FastifyInstance } from 'fastify';
import {
	serializerCompiler,
	validatorCompiler,
	ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { logSlowRequest } from './diagnostics';
import { toAccountPageData, toCrawlTask, toCrawlTaskDto, toItemPageData } from './mapping';
import { ServiceStats } from './stats';

export interface AppOptions {
	store: CrawlStore;
	stats?: ServiceStats;
	/** Counts the URLs that wait to be claimed. Without it /stats has no queue numbers. */
	queueLeft?: () => Promise<{ items: number, accounts: number }>;
	/** Counts the rows of the DB. Without it there is no /totals route. The store caches the numbers. */
	totals?: () => Promise<TotalsResponse>;
	/** Counts when the items and the accounts were processed. Without it there is no /processing-history route. The store caches the numbers. */
	processingHistory?: () => Promise<ProcessingHistoryResponse>;
	/** When set, every request except /health needs this bearer token. */
	token?: string;
	/**
	 * The most requests that are open at the same time. When there are more, the service answers 503
	 * with `Retry-After` at once, so a crowd of crawlers does not pile up behind a slow query.
	 */
	maxOpenRequests?: number;
}

export const DEFAULT_MAX_OPEN_REQUESTS = 200;

/** Seconds that a crawler that was turned away waits. */
const RETRY_AFTER_SECONDS = 2;

const hasValidToken = (header: string | undefined, token: string): boolean => {
	const expected = Buffer.from(`Bearer ${token}`);
	const actual = Buffer.from(header ?? '');
	return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
};

/** The HTTP side of the DB service. It only knows the CrawlStore interface. */
export const buildApp = ({ store, stats = new ServiceStats(), queueLeft, totals, processingHistory, token, maxOpenRequests = DEFAULT_MAX_OPEN_REQUESTS }: AppOptions): FastifyInstance => {
	const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
	app.setValidatorCompiler(validatorCompiler);
	app.setSerializerCompiler(serializerCompiler);

	let open = 0;
	const startedAt = new WeakMap<object, number>();

	// only the requests that reach a handler are counted; /health and /stats are always answered
	app.addHook('onRequest', async (request, reply) => {
		const heavy = request.method === 'POST';
		if (heavy && open >= maxOpenRequests) {
			return reply.code(503).header('Retry-After', String(RETRY_AFTER_SECONDS)).send({ message: 'The DB service is busy' });
		}
		if (heavy) {
			open++;
			startedAt.set(request, performance.now());
		}
		if (token && request.url !== '/health' && !hasValidToken(request.headers.authorization, token)) {
			return reply.code(401).send({ message: 'Unauthorized' });
		}
	});

	app.addHook('onResponse', async request => {
		const start = startedAt.get(request);
		if (start !== undefined) {
			open--;
			logSlowRequest(request.method, request.url, performance.now() - start, open);
		}
	});

	// a request that was cut by the client does not get onResponse
	app.addHook('onRequestAbort', async request => {
		if (startedAt.delete(request)) {
			open--;
		}
	});

	// Every error has the same body: a message string
	app.setErrorHandler((error: FastifyError, _request, reply) => {
		const status = error.statusCode ?? 500;
		const message = status >= 500 ? errorMessage(error) : error.message;
		return reply.code(status).send({ message });
	});

	const errors = { 400: errorResponseSchema, 401: errorResponseSchema, 500: errorResponseSchema };

	app.get('/health', { schema: { response: { 200: healthResponseSchema } } }, async () => ({ status: 'ok' as const }));

	app.get('/stats', { schema: { response: { 200: statsResponseSchema, ...errors } } }, async () => ({ ...stats.snapshot(), ...(queueLeft ? { queueLeft: await queueLeft() } : {}) }));

	if (totals) {
		app.get('/totals', { schema: { response: { 200: totalsResponseSchema, ...errors } } }, async () => await totals());
	}

	if (processingHistory) {
		app.get('/processing-history', { schema: { response: { 200: processingHistoryResponseSchema, ...errors } } }, async () => await processingHistory());
	}

	app.post('/claim', {
		schema: { body: claimRequestSchema, response: { 200: claimResponseSchema, ...errors } },
	}, async ({ body }) => {
		const tasks = await store.claim(body.type as UrlType, body.count, body.newestFirst);
		stats.onClaimed(tasks.length);
		return { tasks: tasks.map(toCrawlTaskDto) };
	});

	app.post('/extend-lease', {
		schema: { body: extendLeaseRequestSchema, response: { 200: extendLeaseResponseSchema, ...errors } },
	}, async ({ body }) => ({ extended: await store.extendLease(toCrawlTask(body.task)) }));

	app.post('/save-item', {
		schema: { body: saveItemRequestSchema, response: { 200: saveItemResponseSchema, ...errors } },
	}, async ({ body }) => {
		const statistic = await store.saveItem(toCrawlTask(body.task), toItemPageData(body.data));
		stats.onItemSaved(statistic.newUrls.length, statistic);
		return { statistic };
	});

	app.post('/save-account', {
		schema: { body: saveAccountRequestSchema, response: { 200: saveAccountResponseSchema, ...errors } },
	}, async ({ body }) => {
		const statistic = await store.saveAccount(toCrawlTask(body.task), toAccountPageData(body.data));
		const newUrls = [statistic.collection, statistic.wishlist, statistic.followers, statistic.following]
			.reduce((sum, tab) => sum + tab.newUrls.length, 0);
		stats.onAccountSaved(newUrls, statistic);
		return { statistic };
	});

	app.post('/control-url', {
		schema: { response: { 200: controlUrlResponseSchema, ...errors } },
	}, async () => {
		const url = await store.controlUrl();
		return url === undefined ? {} : { url };
	});

	app.post('/release', {
		schema: { body: releaseRequestSchema, response: { 200: releaseResponseSchema, ...errors } },
	}, async ({ body }) => {
		await store.release(toCrawlTask(body.task), body.reason as ReleaseReason);
		stats.onReleased();
		return {};
	});

	return app;
};
