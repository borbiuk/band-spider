import { AdminConfig, poolKeyOf } from './config';
import { AdminError } from './errors';

/** What the API shows instead of a secret. It has no part of the real value. */
export const SECRET_MASK = '********';

const maskUrl = (value: string): string => {
	const url = new URL(value);
	if (url.password) {
		url.password = SECRET_MASK;
	}
	return url.toString();
};

/** A copy of the config that is safe to send to the browser. */
export const maskConfig = (config: AdminConfig): AdminConfig => ({
	...(config.webshare ? { webshare: { ...config.webshare, apiKey: SECRET_MASK } } : {}),
	proxyPool: config.proxyPool.map(entry => ({ ...entry, password: SECRET_MASK })),
	dbService: {
		...config.dbService,
		...(config.dbService.token === undefined ? {} : { token: SECRET_MASK }),
	},
	crawlers: config.crawlers.map(crawler => {
		const { proxy } = crawler;
		switch (proxy.kind) {
			case 'none':
			case 'webshare-list':
			case 'pool':
				return crawler;
			case 'url':
				return { ...crawler, proxy: { ...proxy, url: maskUrl(proxy.url) } };
			case 'webshare':
				return { ...crawler, proxy: { ...proxy, entry: { ...proxy.entry, password: SECRET_MASK } } };
		}
	}),
});

const missingSecret = (what: string): AdminError =>
	new AdminError(`${what} is hidden and there is no saved value, send the real one`, 400);

/**
 * The browser sends back the masked values it got from GET /config.
 * This puts the saved secrets back, so saving a masked config does not erase them.
 */
export const restoreSecrets = (incoming: AdminConfig, saved: AdminConfig): AdminConfig => {
	let token = incoming.dbService.token;
	if (token === SECRET_MASK) {
		if (saved.dbService.token === undefined) {
			throw missingSecret('The DB service token');
		}
		token = saved.dbService.token;
	}
	let webshare = incoming.webshare;
	if (webshare?.apiKey === SECRET_MASK) {
		if (!saved.webshare) {
			throw missingSecret('The Webshare API key');
		}
		webshare = saved.webshare;
	}
	const proxyPool = incoming.proxyPool.map(entry => {
		if (entry.password !== SECRET_MASK) {
			return entry;
		}
		const old = saved.proxyPool.find(item => poolKeyOf(item) === poolKeyOf(entry));
		if (!old) {
			throw missingSecret(`The password of the pool proxy ${poolKeyOf(entry)}`);
		}
		return { ...entry, password: old.password };
	});
	return {
		...(webshare ? { webshare } : {}),
		proxyPool,
		dbService: { ...incoming.dbService, ...(token === undefined ? {} : { token }) },
		crawlers: incoming.crawlers.map(crawler => {
			const { proxy } = crawler;
			const old = saved.crawlers.find(item => item.name.toLowerCase() === crawler.name.toLowerCase())?.proxy;
			if (proxy.kind === 'webshare' && proxy.entry.password === SECRET_MASK) {
				if (old?.kind !== 'webshare') {
					throw missingSecret(`The Webshare password of ${crawler.name}`);
				}
				return { ...crawler, proxy: { ...proxy, entry: { ...proxy.entry, password: old.entry.password } } };
			}
			if (proxy.kind === 'url' && new URL(proxy.url).password === SECRET_MASK) {
				if (old?.kind !== 'url') {
					throw missingSecret(`The proxy password of ${crawler.name}`);
				}
				const url = new URL(proxy.url);
				url.password = new URL(old.url).password;
				return { ...crawler, proxy: { ...proxy, url: url.toString() } };
			}
			return crawler;
		}),
	};
};
