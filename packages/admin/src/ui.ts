import fs from 'node:fs';
import path from 'node:path';
import { errorMessage } from '@band-spider/core';
import { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { autoAddText, AutoCrawlerService, autoCrawlerKindSchema } from './auto-crawlers';
import { AdminConfig, adminConfigSchema, crawlerSettingSchema, CrawlerSetting, poolKeyOf } from './config';
import { ConfigStore } from './config-store';
import { AdminError, conflict, notFound } from './errors';
import { countryResultText, ImportMode, ProxyPoolService, RemoveManyResult, removeManyText } from './proxy-pool';
import { maskConfig, restoreSecrets } from './secrets';
import { Supervisor } from './supervisor';
import { bulkText } from './ui-bulk';
import { renderCrawlerDetail } from './ui-detail';
import { renderInsights } from './ui-insights';
import {
	countriesOf,
	emptyForm,
	formFromSetting,
	FormValues,
	renderCrawlerForm,
	renderLogs,
	renderProxyImport,
	renderProxyList,
	renderStatus,
	stripAnsi,
	toast,
} from './ui-render';

export interface UiOptions {
	supervisor: Supervisor;
	configStore: ConfigStore;
	proxyPool: ProxyPoolService;
	autoCrawlers: AutoCrawlerService;
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
const bulkParams = z.object({ action: z.enum(['start', 'stop', 'restart', 'remove']) });

const formSchema = z.object({
	original: z.string().default(''),
	name: z.string().default(''),
	type: z.string().default('item'),
	reverse: z.string().optional(),
	workers: z.string().default(''),
	minDelayMs: z.string().default(''),
	maxDelayMs: z.string().default(''),
	idleMs: z.string().default(''),
	proxyKind: z.string().default('none'),
	proxyUrl: z.string().default(''),
	wsHost: z.string().default(''),
	wsPort: z.string().default(''),
	wsUser: z.string().default(''),
	wsPassword: z.string().default(''),
	listIndex: z.string().default(''),
	listId: z.string().default(''),
	poolKey: z.string().default(''),
});

/** The crawlers chosen in the table. A single checkbox sends a string, many send an array. */
const bulkFormSchema = z.object({
	names: z.union([z.string(), z.array(z.string())]).default([]).transform(value => Array.isArray(value) ? value : [value]),
});

const freeCrawlersFormSchema = z.object({ type: autoCrawlerKindSchema.default('item') });

const chosenCrawlersFormSchema = z.object({
	keys: z.union([z.string(), z.array(z.string())]).default([]).transform(value => Array.isArray(value) ? value : [value]),
	type: z.enum(['item', 'account']).default('item'),
	start: z.string().optional(),
});

const importFormSchema = z.object({
	text: z.string().default(''),
	mode: z.enum(['append', 'replace']).default('append'),
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
	} else if (form.proxyKind === 'webshare-list') {
		proxy = { kind: 'webshare-list', index: optionalNumber(form.listIndex), id: form.listId.trim() || undefined };
	} else if (form.proxyKind === 'pool') {
		proxy = { kind: 'pool', key: form.poolKey };
	}
	return {
		name: form.name.trim(),
		type: form.type,
		reverse: form.reverse,
		workers: optionalNumber(form.workers),
		minDelayMs: optionalNumber(form.minDelayMs),
		maxDelayMs: optionalNumber(form.maxDelayMs),
		idleMs: optionalNumber(form.idleMs),
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
export const registerUi = (app: FastifyInstance, { supervisor, configStore, proxyPool, autoCrawlers }: UiOptions): void => {
	const index = readUiFile('index.html');
	const files: Array<[string, string, Buffer]> = [
		['/assets/htmx.min.js', 'text/javascript; charset=utf-8', fs.readFileSync(HTMX_FILE)],
		['/assets/app.js', 'text/javascript; charset=utf-8', readUiFile('app.js')],
		['/assets/app.css', 'text/css; charset=utf-8', readUiFile('app.css')],
		// a tiny script in the head sets the chosen theme before the page is drawn
		['/assets/theme.js', 'text/javascript; charset=utf-8', readUiFile('theme.js')],
	];

	// htmx sends forms as urlencoded
	app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_request, body, done) => {
		// a field that repeats (the checkboxes of the proxy list) becomes an array
		const fields: Record<string, string | string[]> = {};
		for (const [key, value] of new URLSearchParams(body as string)) {
			const old = fields[key];
			fields[key] = old === undefined ? value : Array.isArray(old) ? [...old, value] : [old, value];
		}
		done(null, fields);
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

	// The current status. The blocks of the page are changed in place ("morph"), so the page does not jump.
	const statusHtml = async (): Promise<string> =>
		renderStatus(await supervisor.status(), await configStore.load(), Date.now());

	// The pool list shows the state and the traffic of the crawlers that use a proxy
	const proxyListHtml = async (): Promise<string> =>
		renderProxyList(await proxyPool.list(), (await supervisor.status()).crawlers);

	const statusOob = async (): Promise<string> =>
		`<div id="status" hx-swap-oob="morph">${await statusHtml()}</div>`;

	// The pool list changes when a crawler is added, changed or removed, so those responses refresh it too
	const poolListOob = async (): Promise<string> =>
		`<div id="proxy-list" hx-swap-oob="morph">${await proxyListHtml()}</div>`;

	const errorText = (error: unknown): string => error instanceof AdminError ? error.message : errorMessage(error);

	// A control button never fails the request, because htmx does not swap error responses. The error shows as a message
	// in the corner of the page, and the next live update of the status does not remove it.
	const control = async (reply: FastifyReply, job: () => Promise<void>, refreshPool = false, done?: string): Promise<FastifyReply> => {
		let message = '';
		try {
			await job();
			message = done ? toast('ok', done) : '';
		} catch (caught) {
			message = toast('error', errorText(caught));
		}
		return html(reply, await statusHtml() + message + (refreshPool ? await poolListOob() : ''));
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
		}, true, `Crawler ${name} removed`);
	});

	app.get('/fragments/crawler-form', async (request, reply) => {
		const { name } = z.object({ name: z.string().optional() }).parse(request.query);
		if (name === undefined) {
			return html(reply, renderCrawlerForm(emptyForm(), await proxyPool.list()));
		}
		// secrets are masked in the form, saving it keeps the saved ones
		const setting = maskConfig(await configStore.load()).crawlers.find(crawler => crawler.name === name);
		if (!setting) {
			return html(reply, renderCrawlerForm(emptyForm(), await proxyPool.list(), `No crawler ${name} in the config`));
		}
		return html(reply, renderCrawlerForm(formFromSetting(setting), await proxyPool.list()));
	});

	app.get('/fragments/crawler-form-close', async (_request, reply) => html(reply, ''));

	// The Insights view. It asks the supervisor for the DB size, and a status event refreshes the view when the count is done.
	app.get('/fragments/insights', async (_request, reply) => html(reply, renderInsights(await supervisor.insights(), Date.now())));

	// The detail drawer of one crawler. The page script asks again on each live update while it is open.
	app.get('/fragments/crawler-detail', async (request, reply) => {
		const { name } = z.object({ name: z.string().min(1) }).parse(request.query);
		const status = (await supervisor.status()).crawlers.find(crawler => crawler.name === name);
		const setting = (await configStore.load()).crawlers.find(crawler => crawler.name === name);
		return html(reply, renderCrawlerDetail(name, status, setting, Date.now(), countriesOf((await configStore.load()).proxyPool)));
	});

	app.get('/fragments/detail-close', async (_request, reply) => html(reply, ''));

	// Start, stop, restart or remove the crawlers chosen in the table. Each crawler is tried, the message says what did not work.
	app.post('/fragments/bulk/:action', async (request, reply) => {
		const { action } = parseParams(bulkParams, request.params);
		const { names } = bulkFormSchema.parse(request.body ?? {});
		if (names.length === 0) {
			return html(reply, await statusHtml() + toast('warn', 'Choose at least one crawler first'));
		}
		const status = await supervisor.status();
		const states = new Map(status.crawlers.map(crawler => [crawler.name, crawler]));
		const failed: string[] = [];
		let done: string[] = [];
		let skipped: string[] = [];
		if (action === 'remove') {
			const config = await configStore.load();
			const removable = new Set(names.filter(name => {
				const state = states.get(name)?.state ?? 'stopped';
				return config.crawlers.some(crawler => crawler.name === name) && (state === 'stopped' || state === 'failed');
			}));
			skipped = names.filter(name => !removable.has(name));
			done = [...removable];
			if (done.length > 0) {
				await configStore.save({ ...config, crawlers: config.crawlers.filter(crawler => !removable.has(crawler.name)) });
			}
		} else {
			const active = (name: string): boolean => ['starting', 'running', 'stopping'].includes(states.get(name)?.state ?? 'stopped');
			const targets = action === 'start' ? names.filter(name => !active(name)) : action === 'stop' ? names.filter(active) : names;
			skipped = names.filter(name => !targets.includes(name));
			if (action !== 'stop' && targets.length > 0 && (status.db.state === 'stopped' || status.db.state === 'failed')) {
				// like "Start all": the DB service comes first, so the crawlers do not start it at the same time
				try {
					await supervisor.startDb();
				} catch (error) {
					return html(reply, await statusHtml() + toast('error', `The DB service did not start: ${errorText(error)}`));
				}
			}
			const job = (name: string): Promise<void> =>
				action === 'start' ? supervisor.startCrawler(name) : action === 'stop' ? supervisor.stopCrawler(name) : supervisor.restartCrawler(name);
			const outcomes = await Promise.allSettled(targets.map(job));
			outcomes.forEach((outcome, i) => outcome.status === 'fulfilled' ? done.push(targets[i]) : failed.push(`${targets[i]}: ${errorText(outcome.reason)}`));
		}
		const text = bulkText(action, done.length, skipped.length, failed);
		return html(reply, await statusHtml()
			+ toast(failed.length ? 'error' : done.length === 0 ? 'warn' : 'ok', text)
			+ (action === 'remove' ? await poolListOob() : ''));
	});

	app.get('/fragments/logs-close', async (_request, reply) => html(reply, ''));

	// Saves a new or an edited crawler. A bad form is shown again with the message.
	app.post('/fragments/crawlers', async (request, reply) => {
		const parsed = formSchema.parse(request.body ?? {});
		const form: FormValues = { ...parsed, reverse: parsed.reverse !== undefined };
		if (form.original) {
			// the name of an existing crawler does not change
			form.name = form.original;
		}
		const fail = async (message: string) => html(reply, renderCrawlerForm(form, await proxyPool.list(), message));

		const setting = crawlerSettingSchema.safeParse(settingFromForm(form));
		if (!setting.success) {
			return await fail(issuesText(setting.error));
		}

		const saved = await configStore.load();
		const crawlers: CrawlerSetting[] = [...saved.crawlers];
		const at = form.original ? crawlers.findIndex(crawler => crawler.name === form.original) : -1;
		if (form.original && at < 0) {
			return await fail(`No crawler ${form.original} in the config`);
		}
		if (at >= 0) {
			crawlers[at] = setting.data;
		} else {
			crawlers.push(setting.data);
		}
		if (setting.data.proxy.kind === 'pool') {
			const { key } = setting.data.proxy;
			if (!saved.proxyPool.some(entry => poolKeyOf(entry) === key)) {
				return await fail(`Proxy ${key} is not in the proxy pool`);
			}
		}
		const candidate = adminConfigSchema.safeParse({ webshare: saved.webshare, proxyPool: saved.proxyPool, dbService: saved.dbService, crawlers });
		if (!candidate.success) {
			return await fail(issuesText(candidate.error));
		}

		let config: AdminConfig;
		try {
			config = restoreSecrets(candidate.data, saved);
		} catch (error) {
			return await fail(errorMessage(error));
		}
		await configStore.save(config);
		// the form closes, and the status and the pool list are updated in the same response
		return html(reply, await statusOob() + await poolListOob()
			+ toast('ok', `Crawler ${setting.data.name} saved. It uses the new settings at the next start.`));
	});

	app.get('/fragments/proxy-import', async (_request, reply) => html(reply, renderProxyImport()));

	app.get('/fragments/proxy-list', async (_request, reply) => html(reply, await proxyListHtml()));

	// A refused import shows its message on the page. The pasted text is not sent back, it holds passwords.
	app.post('/fragments/proxy-import', async (request, reply) => {
		const form = importFormSchema.safeParse(request.body ?? {});
		if (!form.success || form.data.text.trim() === '') {
			return html(reply, renderProxyImport({ error: 'Choose a file or paste a list first' }));
		}
		try {
			const result = await proxyPool.importList(form.data.text, form.data.mode as ImportMode);
			return html(reply, renderProxyImport({ result }) + await poolListOob());
		} catch (error) {
			return html(reply, renderProxyImport({ error: errorText(error) }));
		}
	});

	// Adds one crawler for each free proxy. The crawler table and the pool list are updated in the same response.
	app.post('/fragments/proxies/free-crawlers', async (request, reply) => {
		const form = freeCrawlersFormSchema.safeParse(request.body ?? {});
		if (!form.success) {
			return html(reply, await proxyListHtml() + toast('error', issuesText(form.error)));
		}
		const result = await autoCrawlers.addForFreeProxies(form.data.type);
		return html(reply, await proxyListHtml() + await statusOob()
			+ toast(result.added === 0 ? 'warn' : 'ok', autoAddText(result)));
	});

	// Adds one crawler for each chosen proxy, and starts them when asked. A crawler that does not start stays in the config.
	app.post('/fragments/proxies/chosen-crawlers', async (request, reply) => {
		const form = chosenCrawlersFormSchema.safeParse(request.body ?? {});
		if (!form.success) {
			return html(reply, await proxyListHtml() + toast('error', issuesText(form.error)));
		}
		if (form.data.keys.length === 0) {
			return html(reply, await proxyListHtml() + toast('warn', 'Choose at least one proxy first'));
		}
		const result = await autoCrawlers.addForProxies(form.data.keys, form.data.type);
		let message = toast(result.added === 0 ? 'warn' : 'ok', result.added === 0
			? 'No crawler added: the chosen proxies are not in the pool'
			: autoAddText(result));
		if (form.data.start !== undefined && result.added > 0) {
			// like "Start all": the DB service comes first, so the crawlers do not start it at the same time
			const dbState = (await supervisor.status()).db.state;
			if (dbState === 'stopped' || dbState === 'failed') {
				try {
					await supervisor.startDb();
				} catch (error) {
					return html(reply, await proxyListHtml() + await statusOob() + message
						+ toast('error', `Crawlers were added but not started: ${errorText(error)}`));
				}
			}
			const outcomes = await Promise.allSettled(result.names.map(name => supervisor.startCrawler(name)));
			const failed = outcomes.flatMap((outcome, i) => outcome.status === 'rejected' ? [`${result.names[i]}: ${errorText(outcome.reason)}`] : []);
			message += failed.length
				? toast('error', `${failed.length} of ${result.added} crawlers did not start. ${failed.slice(0, 3).join('; ')}`)
				: toast('ok', `${result.added} ${result.added === 1 ? 'crawler' : 'crawlers'} started`);
		}
		return html(reply, await proxyListHtml() + await statusOob() + message);
	});

	const removeManyToast = (result: RemoveManyResult): string =>
		toast(result.kept.length > 0 ? 'warn' : 'ok', removeManyText(result));

	// Asks the Webshare API for the country of each proxy. A missing key or an API error shows as a message.
	app.post('/fragments/proxies/detect-countries', async (_request, reply) => {
		try {
			const result = await proxyPool.detectCountries();
			return html(reply, await proxyListHtml() + toast(result.matched === 0 ? 'warn' : 'ok', countryResultText(result)));
		} catch (error) {
			return html(reply, await proxyListHtml() + toast('error', errorText(error)));
		}
	});

	// Deletes the whole pool, or the chosen proxies. Proxies that crawlers use are kept and named in the message.
	app.post('/fragments/proxies/delete-all', async (_request, reply) => {
		const result = await proxyPool.removeMany();
		return html(reply, await proxyListHtml() + removeManyToast(result));
	});

	app.post('/fragments/proxies/delete-chosen', async (request, reply) => {
		const form = chosenCrawlersFormSchema.safeParse(request.body ?? {});
		if (!form.success || form.data.keys.length === 0) {
			return html(reply, await proxyListHtml() + toast('warn', 'Choose at least one proxy first'));
		}
		const result = await proxyPool.removeMany(form.data.keys);
		return html(reply, await proxyListHtml() + removeManyToast(result));
	});

	app.delete('/fragments/proxy-list/:key', async (request, reply) => {
		const { key } = z.object({ key: z.string().min(1) }).parse(request.params);
		let error: string | undefined;
		try {
			await proxyPool.remove(key);
		} catch (caught) {
			error = errorText(caught);
		}
		return html(reply, await proxyListHtml() + (error ? toast('error', error) : ''));
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
