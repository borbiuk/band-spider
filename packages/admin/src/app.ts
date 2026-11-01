import { errorMessage } from '@band-spider/core';
import Fastify, { FastifyError, FastifyInstance } from 'fastify';
import {
	serializerCompiler,
	validatorCompiler,
	ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { z } from 'zod';
import { adminConfigSchema } from './config';
import { ConfigStore } from './config-store';
import { AdminError } from './errors';
import { maskConfig, restoreSecrets } from './secrets';
import { registerSecurity, SecurityOptions } from './security';
import { Supervisor } from './supervisor';

export interface AppOptions {
	supervisor: Supervisor;
	configStore: ConfigStore;
	security: SecurityOptions;
}

const nameParams = z.object({ name: z.string().min(1) });
const logsQuery = z.object({ limit: z.coerce.number().int().min(1).max(5000).optional() });

/** The JSON API of the admin. It only knows the Supervisor and the ConfigStore. */
export const buildApp = ({ supervisor, configStore, security }: AppOptions): FastifyInstance => {
	const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
	app.setValidatorCompiler(validatorCompiler);
	app.setSerializerCompiler(serializerCompiler);
	registerSecurity(app, security);

	// Every error has the same body: a message string
	app.setErrorHandler((error: FastifyError, _request, reply) => {
		const status = error instanceof AdminError ? error.status : error.statusCode ?? 500;
		const message = status >= 500 ? errorMessage(error) : error.message;
		return reply.code(status).send({ message });
	});

	app.get('/health', async () => ({ status: 'ok' }));

	// Secrets are never sent in full
	app.get('/config', async () => maskConfig(await configStore.load()));

	// The new config is used the next time a process starts
	app.put('/config', { schema: { body: adminConfigSchema } }, async ({ body }) => {
		const config = restoreSecrets(body, await configStore.load());
		await configStore.save(config);
		return maskConfig(config);
	});

	app.get('/status', async () => supervisor.status());

	app.post('/start-all', async () => {
		await supervisor.startAll();
		return supervisor.status();
	});

	app.post('/stop-all', async () => {
		await supervisor.stopAll();
		return supervisor.status();
	});

	app.post('/db/start', async () => {
		await supervisor.startDb();
		return supervisor.status();
	});

	app.post('/db/stop', async () => {
		await supervisor.stopDb();
		return supervisor.status();
	});

	app.post('/db/restart', async () => {
		await supervisor.restartDb();
		return supervisor.status();
	});

	app.get('/db/logs', { schema: { querystring: logsQuery } }, async ({ query }) => ({
		lines: supervisor.dbLogs(query.limit),
	}));

	app.post('/crawlers/:name/start', { schema: { params: nameParams } }, async ({ params }) => {
		await supervisor.startCrawler(params.name);
		return supervisor.status();
	});

	app.post('/crawlers/:name/stop', { schema: { params: nameParams } }, async ({ params }) => {
		await supervisor.stopCrawler(params.name);
		return supervisor.status();
	});

	app.post('/crawlers/:name/restart', { schema: { params: nameParams } }, async ({ params }) => {
		await supervisor.restartCrawler(params.name);
		return supervisor.status();
	});

	app.get('/crawlers/:name/logs', { schema: { params: nameParams, querystring: logsQuery } }, async ({ params, query }) => ({
		lines: supervisor.crawlerLogs(params.name, query.limit),
	}));

	return app;
};
