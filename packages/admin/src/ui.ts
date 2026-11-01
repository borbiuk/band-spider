import fs from 'node:fs';
import path from 'node:path';
import { errorMessage } from '@band-spider/core';
import { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { AdminConfig, adminConfigSchema, crawlerSettingSchema, CrawlerSetting } from './config';
import { ConfigStore } from './config-store';
import { AdminError, conflict, notFound } from './errors';
import { maskConfig, restoreSecrets } from './secrets';
import { Supervisor } from './supervisor';
import {
	emptyForm,
	formFromSetting,
	FormValues,
	renderCrawlerForm,
	renderLogs,
	renderStatus,
	stripAnsi,
} from './ui-render';

export interface UiOptions {
	supervisor: Supervisor;
	configStore: ConfigStore;
}

// The page files are in packages/admin/ui, next to dist. They need no build step.
const UI_DIR = path.join(__dirname, '..', 'ui');
const readUiFile = (name: string): Buffer => fs.readFileSync(path.join(UI_DIR, name));

// htmx comes from its npm package, not from a CDN
const HTMX_FILE = require.resolve('htmx.org/dist/htmx.min.js');

const HEARTBEAT_MS = 15_000;

// Only files of this server may load, and no frames
const PAGE_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'";

const controlParams = z.object({ action: z.enum(['start', 'stop', 'restart']) });
const crawlerParams = z.object({ name: z.string().min(1), action: z.enum(['start', 'stop', 'restart']) });
const allParams = z.object({ action: z.enum(['start', 'stop']) });

const formSchema = z.object({
	original: z.string().default(''),
	name: z.string().default(''),
	type: z.string().default('item'),
	reverse: z.string().optional(),
	workers: z.string().default('1'),
	minDelayMs: z.string().default(''),
	maxDelayMs: z.string().default(''),
	proxyKind: z.string().default('none'),
	proxyUrl: z.string().default(''),
	wsHost: z.string().default(''),
	wsPort: z.string().default(''),
	wsUser: z.string().default(''),
	wsPassword: z.string().default(''),
});

const optionalNumber = (value: string): number | undefined => value.trim() === '' ? undefined : Number(value);

/** Turns the form fields into a crawler setting. The setting schema checks the values. */
const settingFromForm = (form: FormValues): unknown => {
	let proxy: unknown = { kind: 'none' };
	if (form.proxyKind === 'url') {
		proxy = { kind: 'url', url: form.proxyUrl.trim() };
	} else if (form.proxyKind === 'webshare') {
		proxy = {
			kind: 'webshare',
			entry: { host: form.wsHost.trim(), port: Number(form.wsPort), username: form.wsUser, password: form.wsPassword },
		};
	}
	return {
		name: form.name.trim(),
		type: form.type,
		reverse: form.reverse,
		workers: Number(form.workers),
		minDelayMs: optionalNumber(form.minDelayMs),
		maxDelayMs: optionalNumber(form.maxDelayMs),
		proxy,
	};
};

const issuesText = (error: z.ZodError): string =>
	error.issues.map(issue => issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message).join('; ');

/** Parses route params. A value that does not fit is a missing route. */
const parseParams = <T>(schema: z.ZodType<T>, value: unknown): T => {
	const result = schema.safeParse(value);
	if (!result.success) {
		throw notFound('Unknown route');
	}
	return result.data;
};

const html = (reply: FastifyReply, body: string): FastifyReply =>
	reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').send(body);

/** The page, the htmx fragments and the SSE stream. All routes pass the security hook of the app. */
export const registerUi = (app: FastifyInstance, { supervisor, configStore }: UiOptions): void => {
	const index = readUiFile('index.html');
	const files: Array<[string, string, Buffer]> = [
		['/assets/htmx.min.js', 'text/javascript; charset=utf-8', fs.readFileSync(HTMX_FILE)],
		['/assets/app.js', 'text/javascript; charset=utf-8', readUiFile('app.js')],
		['/assets/app.css', 'text/css; charset=utf-8', readUiFile('app.css')],
	];

	// htmx sends forms as urlencoded
	app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_request, body, done) => {
		done(null, Object.fromEntries(new URLSearchParams(body as string)));
	});

	app.get('/', async (_request, reply) =>
		reply
			.type('text/html; charset=utf-8')
			.header('content-security-policy', PAGE_CSP)
			.header('x-frame-options', 'DENY')
			.header('x-content-type-options', 'nosniff')
			.send(index));

	for (const [route, type, content] of files) {
		app.get(route, async (_request, reply) => reply.type(type).header('cache-control', 'no-cache').send(content));
	}

	// The current status with an optional error message
	const statusHtml = async (error?: string): Promise<string> =>
		renderStatus(await supervisor.status(), await configStore.load(), error);

	// A control button never fails the request, because htmx does not swap error responses. The error is shown on the page.
	const control = async (reply: FastifyReply, job: () => Promise<void>): Promise<FastifyReply> => {
		let error: string | undefined;
		try {
			await job();
		} catch (caught) {
			error = caught instanceof AdminError ? caught.message : errorMessage(caught);
		}
		return html(reply, await statusHtml(error));
	};

	app.get('/fragments/status', async (_request, reply) => html(reply, await statusHtml()));

	app.post('/fragments/db/:action', async (request, reply) => {
		const { action } = parseParams(controlParams, request.params);
		return control(reply, () => action === 'start' ? supervisor.startDb() : action === 'stop' ? supervisor.stopDb() : supervisor.restartDb());
	});

	app.post('/fragments/all/:action', async (request, reply) => {
		const { action } = parseParams(allParams, request.params);
		return control(reply, () => action === 'start' ? supervisor.startAll() : supervisor.stopAll());
	});

	app.post('/fragments/crawlers/:name/:action', async (request, reply) => {
		const { name, action } = parseParams(crawlerParams, request.params);
		return control(reply, () =>
			action === 'start' ? supervisor.startCrawler(name)
				: action === 'stop' ? supervisor.stopCrawler(name)
					: supervisor.restartCrawler(name));
	});

	app.delete('/fragments/crawlers/:name', async (request, reply) => {
		const { name } = z.object({ name: z.string().min(1) }).parse(request.params);
		return control(reply, async () => {
			const config = await configStore.load();
			if (!config.crawlers.some(crawler => crawler.name === name)) {
				throw notFound(`No crawler ${name} in the config`);
			}
			const state = (await supervisor.status()).crawlers.find(crawler => crawler.name === name)?.state;
			if (state !== 'stopped' && state !== 'failed') {
				throw conflict(`Stop crawler ${name} first`);
			}
			await configStore.save({ ...config, crawlers: config.crawlers.filter(crawler => crawler.name !== name) });
		});
	});

	app.get('/fragments/crawler-form', async (request, reply) => {
		const { name } = z.object({ name: z.string().optional() }).parse(request.query);
		if (name === undefined) {
			return html(reply, renderCrawlerForm(emptyForm()));
		}
		// secrets are masked in the form, saving it keeps the saved ones
		const setting = maskConfig(await configStore.load()).crawlers.find(crawler => crawler.name === name);
		if (!setting) {
			return html(reply, renderCrawlerForm(emptyForm(), `No crawler ${name} in the config`));
		}
		return html(reply, renderCrawlerForm(formFromSetting(setting)));
	});

	app.get('/fragments/crawler-form-close', async (_request, reply) => html(reply, ''));

	// Saves a new or an edited crawler. A bad form is shown again with the message.
	app.post('/fragments/crawlers', async (request, reply) => {
		const parsed = formSchema.parse(request.body ?? {});
		const form: FormValues = { ...parsed, reverse: parsed.reverse !== undefined };
		if (form.original) {
			// the name of an existing crawler does not change
			form.name = form.original;
		}
		const fail = (message: string) => html(reply, renderCrawlerForm(form, message));

		const setting = crawlerSettingSchema.safeParse(settingFromForm(form));
		if (!setting.success) {
			return fail(issuesText(setting.error));
		}

		const saved = await configStore.load();
		const crawlers: CrawlerSetting[] = [...saved.crawlers];
		const at = form.original ? crawlers.findIndex(crawler => crawler.name === form.original) : -1;
		if (form.original && at < 0) {
			return fail(`No crawler ${form.original} in the config`);
		}
		if (at >= 0) {
			crawlers[at] = setting.data;
		} else {
			crawlers.push(setting.data);
		}
		const candidate = adminConfigSchema.safeParse({ dbService: saved.dbService, crawlers });
		if (!candidate.success) {
			return fail(issuesText(candidate.error));
		}

		let config: AdminConfig;
		try {
			config = restoreSecrets(candidate.data, saved);
		} catch (error) {
			return fail(errorMessage(error));
		}
		await configStore.save(config);
		// the form closes and the status is updated in the same response
		return html(reply, `<div id="status" hx-swap-oob="innerHTML">${await statusHtml()}</div>`);
	});

	app.get('/fragments/logs', async (request, reply) => {
		const { source } = z.object({ source: z.string().min(1) }).parse(request.query);
		let lines: string[] = [];
		try {
			lines = source === 'db'
				? supervisor.dbLogs()
				: source.startsWith('crawler:') ? supervisor.crawlerLogs(source.slice('crawler:'.length)) : [];
		} catch (error) {
			// a crawler that has not run yet has no output
			if (!(error instanceof AdminError) || error.status !== 404) {
				throw error;
			}
		}
		return html(reply, renderLogs(source, lines));
	});

	// Server-sent events: "status" says something changed, "log" carries new output
	app.get('/events', (request, reply) => {
		reply.hijack();
		const res = reply.raw;
		res.writeHead(200, {
			'content-type': 'text/event-stream; charset=utf-8',
			'cache-control': 'no-cache, no-transform',
			'x-content-type-options': 'nosniff',
		});
		res.write('retry: 3000\n: connected\n\n');

		const send = (event: string, data: string): void => {
			if (!res.writableEnded) {
				res.write(`event: ${event}\ndata: ${data}\n\n`);
			}
		};
		const unsubscribe = supervisor.subscribe(change => {
			if (change.kind === 'status') {
				send('status', '{}');
			} else {
				send('log', JSON.stringify({ source: change.source, text: stripAnsi(change.text) }));
			}
		});
		const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
		heartbeat.unref();
		request.raw.on('close', () => {
			clearInterval(heartbeat);
			unsubscribe();
		});
	});
};
