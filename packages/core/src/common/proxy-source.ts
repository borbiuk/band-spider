import { fetch as undiciFetch, ProxyAgent } from 'undici';

/** Where the requests of one HttpClient leave from: the local IP or a proxy. */
export interface ProxySource {
	/** The fetch function that sends a request the way this source says. */
	readonly fetchFn: typeof fetch;
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

/** One fixed proxy URL, for example `http://user:pass@host:port`. */
export class StaticProxy implements ProxySource {
	public readonly fetchFn: typeof fetch;
	private readonly agent: ProxyAgent;

	constructor(proxyUrl: string) {
		this.agent = new ProxyAgent(proxyUrl);
		// undici has its own Response type, which is the same at run time
		this.fetchFn = ((input: unknown, init?: RequestInit) => undiciFetch(input as never, { ...init, dispatcher: this.agent } as never)) as unknown as typeof fetch;
	}

	public close(): Promise<void> {
		return this.agent.close();
	}
}
