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
	const create = (starts: number[] = []) => new HttpClient(new RateLimitGate(), {
		fetchFn: async () => { starts.push(Date.now()); return new Response('ok'); },
		minDelayMs: 40,
		maxDelayMs: 40,
	});

	it('keeps the minimum distance between request starts for many callers of one client', async () => {
		const starts: number[] = [];
		const client = create(starts);

		await Promise.all(Array.from({ length: 6 }, (_, i) => client.get(`https://x.bandcamp.com/${i}`)));

		assert.equal(starts.length, 6);
		for (let i = 1; i < starts.length; i++) {
			// a small tolerance for timer rounding
			assert.ok(starts[i] - starts[i - 1] >= 35, `gap ${i}: ${starts[i] - starts[i - 1]}`);
		}
	});

	it('does not delay the first request', async () => {
		const starts: number[] = [];
		const before = Date.now();
		await create(starts).get('https://x.bandcamp.com/a');
		assert.ok(starts[0] - before < 30);
	});

	it('does not share the pacing between two clients', async () => {
		const starts: number[] = [];
		const before = Date.now();
		await Promise.all([create(starts).get('https://x.bandcamp.com/a'), create(starts).get('https://x.bandcamp.com/b')]);
		assert.ok(starts.every(start => start - before < 30));
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
