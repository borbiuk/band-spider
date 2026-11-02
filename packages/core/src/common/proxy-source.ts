import { DecoratorHandler, Dispatcher, fetch as undiciFetch, ProxyAgent } from 'undici';

/** Bytes that went over the wire of one source: request lines and headers and bodies out, status lines, headers and still compressed bodies in. */
export interface TrafficMeter {
	sent: number;
	received: number;
}

/** Where the requests of one HttpClient leave from: the local IP or a proxy. */
export interface ProxySource {
	/** The fetch function that sends a request the way this source says. */
	readonly fetchFn: typeof fetch;
	/** What this source has sent and received. Only a source that can see its own traffic has it. */
	readonly traffic?: Readonly<TrafficMeter>;
	/** Frees the connections of this source. */
	close(): Promise<void>;
}

/** No proxy: requests leave from the local IP. */
export class NoProxy implements ProxySource {
	// looked up on every call, so a replaced global fetch is used (tests do this)
	public readonly fetchFn: typeof fetch = (input, init) => globalThis.fetch(input, init);

	public async close(): Promise<void> {
	}
}

type HeaderValue = string | string[] | undefined;

const headersSize = (headers: Iterable<[string, HeaderValue]>): number => {
	let size = 0;
	for (const [name, value] of headers) {
		// "name: value\r\n"
		size += name.length + String(value ?? '').length + 4;
	}
	return size;
};

/** Request headers come as an object or as a flat list of names and values. */
const requestHeadersSize = (headers: unknown): number => {
	if (Array.isArray(headers)) {
		let size = 0;
		for (let i = 0; i + 1 < headers.length; i += 2) {
			size += String(headers[i]).length + String(headers[i + 1]).length + 4;
		}
		return size;
	}
	return headers ? headersSize(Object.entries(headers as Record<string, HeaderValue>)) : 0;
};

const bodySize = (body: unknown): number =>
	typeof body === 'string' ? Buffer.byteLength(body) : body instanceof Uint8Array ? body.byteLength : 0;

// The undici types of DecoratorHandler do not list the methods of the handler API it forwards, so they are named here
interface ForwardingHandler {
	onResponseStart(controller: unknown, statusCode: number, headers: Record<string, HeaderValue>, statusMessage?: string): void;
	onResponseData(controller: unknown, chunk: Buffer): void;
}
const ForwardingHandlerBase = DecoratorHandler as unknown as new (handler: unknown) => ForwardingHandler;

/** Counts the size of an answer as it comes in, before it is decompressed. */
class ReceivedCounter extends ForwardingHandlerBase {
	constructor(private readonly traffic: TrafficMeter, handler: unknown) {
		super(handler);
	}

	public override onResponseStart(controller: unknown, statusCode: number, headers: Record<string, HeaderValue>, statusMessage?: string): void {
		this.traffic.received += headersSize(Object.entries(headers)) + 15;
		super.onResponseStart(controller, statusCode, headers, statusMessage);
	}

	public override onResponseData(controller: unknown, chunk: Buffer): void {
		this.traffic.received += chunk.length;
		super.onResponseData(controller, chunk);
	}
}

/** One fixed proxy URL, for example `http://user:pass@host:port`. */
export class StaticProxy implements ProxySource {
	public readonly fetchFn: typeof fetch;
	public readonly traffic: TrafficMeter = { sent: 0, received: 0 };
	private readonly agent: ProxyAgent;
	private readonly dispatcher: Dispatcher;

	constructor(proxyUrl: string) {
		// always a CONNECT tunnel, also for http:// URLs (undici 8 sends those to the proxy in plain form)
		this.agent = new ProxyAgent({ uri: proxyUrl, proxyTunnel: true });
		// the traffic is counted on the way through the dispatcher, where the bytes are still compressed, as the proxy bills them
		this.dispatcher = this.agent.compose(dispatch => (options, handler) => {
			this.traffic.sent += `${options.method} ${options.path} HTTP/1.1\r\n`.length
				+ (options.origin ? String(new URL(String(options.origin)).host).length + 8 : 0)
				+ requestHeadersSize(options.headers) + bodySize(options.body);
			return dispatch(options, new ReceivedCounter(this.traffic, handler));
		});
		// undici has its own Response type, which is the same at run time
		this.fetchFn = ((input: unknown, init?: RequestInit) => undiciFetch(input as never, { ...init, dispatcher: this.dispatcher } as never)) as unknown as typeof fetch;
	}

	public close(): Promise<void> {
		return this.agent.close();
	}
}
