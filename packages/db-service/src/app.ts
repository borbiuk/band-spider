import crypto from 'node:crypto';
import {
	claimRequestSchema,
	claimResponseSchema,
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
	statsResponseSchema,
} from '@band-spider/contracts';
import { CrawlStore, errorMessage, ReleaseReason, UrlType } from '@band-spider/core';
import Fastify, { FastifyError, FastifyInstance } from 'fastify';
import {
	serializerCompiler,
	validatorCompiler,
	ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { toAccountPageData, toCrawlTask, toCrawlTaskDto, toItemPageData } from './mapping';
import { ServiceStats } from './stats';

export interface AppOptions {
	store: CrawlStore;
	stats?: ServiceStats;
	/** Counts the URLs that wait to be claimed. Without it /stats has no queue numbers. */
	queueLeft?: () => Promise<{ items: number, accounts: number }>;
	/** When set, every request except /health needs this bearer token. */
	token?: string;
}

const hasValidToken = (header: string | undefined, token: string): boolean => {
	const expected = Buffer.from(`Bearer ${token}`);
	const actual = Buffer.from(header ?? '');
	return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
};

/** The HTTP side of the DB service. It only knows the CrawlStore interface. */
export const buildApp = ({ store, stats = new ServiceStats(), queueLeft, token }: AppOptions): FastifyInstance => {
	const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
	app.setValidatorCompiler(validatorCompiler);
	app.setSerializerCompiler(serializerCompiler);

	app.addHook('onRequest', async (request, reply) => {
		if (token && request.url !== '/health' && !hasValidToken(request.headers.authorization, token)) {
			return reply.code(401).send({ message: 'Unauthorized' });
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
		stats.onItemSaved(statistic.newUrls.length);
		return { statistic };
	});

	app.post('/save-account', {
		schema: { body: saveAccountRequestSchema, response: { 200: saveAccountResponseSchema, ...errors } },
	}, async ({ body }) => {
		const statistic = await store.saveAccount(toCrawlTask(body.task), toAccountPageData(body.data));
		const newUrls = [statistic.collection, statistic.wishlist, statistic.followers, statistic.following]
			.reduce((sum, tab) => sum + tab.newUrls.length, 0);
		stats.onAccountSaved(newUrls);
		return { statistic };
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
