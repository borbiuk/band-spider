import assert from 'node:assert/strict';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { HttpClient } from '../common/http-client';
import { NoProxy, StaticProxy } from '../common/proxy-source';
import { RateLimitGate } from '../common/rate-limit-gate';

const listen = (server: http.Server): Promise<string> => new Promise(resolve => {
	server.listen(0, '127.0.0.1', () => resolve(`127.0.0.1:${(server.address() as AddressInfo).port}`));
});

const close = (server: http.Server): Promise<void> => new Promise(resolve => {
	server.closeAllConnections();
	server.close(() => resolve());
});

describe('request pacing', () => {
	const PAUSE_MS = 40;

	interface Entry { start: number, end: number }

	/** A fetch that takes `durationMs` and records when each request starts and ends. */
	const create = (log: Entry[], durationMs = 0) => new HttpClient(new RateLimitGate(), {
		fetchFn: async () => {
			const entry = { start: Date.now(), end: 0 };
			log.push(entry);
			await new Promise(resolve => setTimeout(resolve, durationMs));
			entry.end = Date.now();
			return new Response('ok');
		},
		minDelayMs: PAUSE_MS,
		maxDelayMs: PAUSE_MS,
	});

	it('counts the pause from the end of the previous request to the start of the next one', async () => {
		const log: Entry[] = [];
		const client = create(log, 60);

		await client.get('https://x.bandcamp.com/a');
		await client.get('https://x.bandcamp.com/b');

		// a small tolerance for timer rounding
		assert.ok(log[1].start - log[0].end >= PAUSE_MS - 5, `gap: ${log[1].start - log[0].end}`);
		// the request time is not part of the pause: start to start is about 60 + 40 ms
		assert.ok(log[1].start - log[0].start >= 60 + PAUSE_MS - 5);
	});

	it('never overlaps requests and keeps the pause for many concurrent callers', async () => {
		const log: Entry[] = [];
		const client = create(log, 10);

		await Promise.all(Array.from({ length: 6 }, (_, i) => client.get(`https://x.bandcamp.com/${i}`)));

		assert.equal(log.length, 6);
		for (let i = 1; i < log.length; i++) {
			assert.ok(log[i].start >= log[i - 1].end, `request ${i} started before the previous one ended`);
			assert.ok(log[i].start - log[i - 1].end >= PAUSE_MS - 5, `gap ${i}: ${log[i].start - log[i - 1].end}`);
		}
	});

	it('serves concurrent callers in the order of the calls', async () => {
		const order: string[] = [];
		const client = new HttpClient(new RateLimitGate(), {
			fetchFn: async input => { order.push(String(input)); return new Response('ok'); },
			minDelayMs: 0,
			maxDelayMs: 0,
		});

		await Promise.all(['a', 'b', 'c', 'd'].map(name => client.get(name)));

		assert.deepEqual(order, ['a', 'b', 'c', 'd']);
	});

	it('counts the pause from the end of a failed request too', async () => {
		const log: Entry[] = [];
		const client = new HttpClient(new RateLimitGate(), {
			fetchFn: async () => {
				const entry = { start: Date.now(), end: 0 };
				log.push(entry);
				await new Promise(resolve => setTimeout(resolve, 30));
				entry.end = Date.now();
				throw new Error('network down');
			},
			minDelayMs: PAUSE_MS,
			maxDelayMs: PAUSE_MS,
		});

		await assert.rejects(client.get('https://x.bandcamp.com/a'), /network down/);
		await assert.rejects(client.get('https://x.bandcamp.com/b'), /network down/);

		assert.ok(log[1].start - log[0].end >= PAUSE_MS - 5);
	});

	it('does not delay the first request', async () => {
		const log: Entry[] = [];
		const before = Date.now();
		await create(log).get('https://x.bandcamp.com/a');
		assert.ok(log[0].start - before < 30);
	});

	it('does not share the pacing between two clients', async () => {
		const log: Entry[] = [];
		const before = Date.now();
		await Promise.all([create(log).get('https://x.bandcamp.com/a'), create(log).get('https://x.bandcamp.com/b')]);
		assert.ok(log.every(entry => entry.start - before < 30));
	});
});

describe('proxy sources', () => {
	let proxy: http.Server;
	let proxyHost: string;
	let target: http.Server;
	let targetHost: string;
	const proxySeen: string[] = [];
	const targetSeen: string[] = [];

	before(async () => {
		// a fake HTTP proxy: undici opens a tunnel with CONNECT, and the proxy joins it to the target
		proxy = http.createServer();
		proxy.on('connect', (req, clientSocket, head) => {
			proxySeen.push(req.url);
			const [host, port] = req.url.split(':');
			const upstream = net.connect(Number(port), host, () => {
				clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
				upstream.write(head);
				upstream.pipe(clientSocket);
				clientSocket.pipe(upstream);
			});
			upstream.on('error', () => clientSocket.destroy());
			clientSocket.on('error', () => upstream.destroy());
		});
		target = http.createServer((req, res) => {
			targetSeen.push(req.url);
			res.end('direct');
		});
		proxyHost = await listen(proxy);
		targetHost = await listen(target);
	});

	after(async () => {
		await close(proxy);
		await close(target);
	});

	it('StaticProxy sends the request through the proxy', async () => {
		proxySeen.length = 0;
		targetSeen.length = 0;
		const source = new StaticProxy(`http://${proxyHost}`);
		const client = new HttpClient(new RateLimitGate(), { proxySource: source, minDelayMs: 0, maxDelayMs: 0 });

		try {
			const response = await client.get(`http://${targetHost}/page`);
			assert.deepEqual(response, { status: 200, body: 'direct' });
		} finally {
			await source.close();
		}

		assert.deepEqual(proxySeen, [targetHost], 'the proxy was asked to connect to the target');
		assert.deepEqual(targetSeen, ['/page'], 'the target answered through the tunnel');
	});

	it('NoProxy goes to the target and not to a proxy', async () => {
		proxySeen.length = 0;
		targetSeen.length = 0;
		const client = new HttpClient(new RateLimitGate(), { proxySource: new NoProxy(), minDelayMs: 0, maxDelayMs: 0 });

		assert.deepEqual(await client.get(`http://${targetHost}/page`), { status: 200, body: 'direct' });
		assert.deepEqual(targetSeen, ['/page']);
		assert.deepEqual(proxySeen, []);
	});

	it('uses NoProxy when no source is given', async () => {
		targetSeen.length = 0;
		const client = new HttpClient(new RateLimitGate(), { minDelayMs: 0, maxDelayMs: 0 });

		assert.deepEqual(await client.get(`http://${targetHost}/x`), { status: 200, body: 'direct' });
		assert.deepEqual(targetSeen, ['/x']);
	});
});
