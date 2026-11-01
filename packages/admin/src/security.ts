import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export const SESSION_COOKIE = 'admin_token';
export const TOKEN_HEADER = 'x-admin-token';

export interface SecurityOptions {
	/** The random session token. Every route except /health and /session needs it. */
	token: string;
	/** The port the server really listens on. It is known only after listen, so it is read per request. */
	port: () => number;
}

/** A new random token for one admin run. */
export const generateToken = (): string => randomBytes(32).toString('hex');

/** Splits "host:port" and accepts only a local host name. A missing port means 80. */
const parseLocalHost = (value: string): { host: string; port: number } | undefined => {
	const match = /^(127\.0\.0\.1|localhost|\[::1\])(?::(\d{1,5}))?$/i.exec(value);
	if (!match) {
		return undefined;
	}
	return { host: match[1].toLowerCase(), port: match[2] === undefined ? 80 : Number(match[2]) };
};

/** True when the Host header is a local name with the port of this server. */
export const isAllowedHost = (hostHeader: string | undefined, port: number): boolean => {
	const parsed = hostHeader === undefined ? undefined : parseLocalHost(hostHeader);
	return parsed !== undefined && parsed.port === port;
};

/** True when the Origin header is the page of this server (http only, the admin has no TLS). */
export const isAllowedOrigin = (origin: string, port: number): boolean => {
	const match = /^http:\/\/(.+)$/i.exec(origin);
	return match !== null && isAllowedHost(match[1], port);
};

// Compare digests, so the length of the token does not leak
const sameToken = (given: string | undefined, expected: string): boolean => {
	if (!given) {
		return false;
	}
	const hash = (value: string): Buffer => createHash('sha256').update(value).digest();
	return timingSafeEqual(hash(given), hash(expected));
};

const readCookie = (header: string | undefined, name: string): string | undefined => {
	for (const part of (header ?? '').split(';')) {
		const index = part.indexOf('=');
		if (index > 0 && part.slice(0, index).trim() === name) {
			return part.slice(index + 1).trim();
		}
	}
	return undefined;
};

const headerValue = (value: string | string[] | undefined): string | undefined =>
	Array.isArray(value) ? value[0] : value;

const requestToken = (request: FastifyRequest): string | undefined => {
	const authorization = headerValue(request.headers.authorization);
	if (authorization?.startsWith('Bearer ')) {
		return authorization.slice('Bearer '.length);
	}
	return headerValue(request.headers[TOKEN_HEADER]) ?? readCookie(request.headers.cookie, SESSION_COOKIE);
};

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const reject = (reply: FastifyReply, status: number, message: string) => reply.code(status).send({ message });

/**
 * Protects the admin from other sites in the browser:
 * the Host header must be a local name with our port (against DNS rebinding),
 * a state-changing request must come from our own origin (against CSRF),
 * and every route except /health and /session needs the session token.
 */
export const registerSecurity = (app: FastifyInstance, { token, port }: SecurityOptions): void => {
	app.addHook('onRequest', async (request, reply) => {
		if (!isAllowedHost(request.headers.host, port())) {
			return reject(reply, 403, 'Host is not allowed');
		}
		const origin = headerValue(request.headers.origin);
		if (!SAFE_METHODS.has(request.method) && origin !== undefined && !isAllowedOrigin(origin, port())) {
			return reject(reply, 403, 'Origin is not allowed');
		}
		const path = request.url.split('?')[0];
		if (path === '/health' || path === '/session') {
			return;
		}
		if (!sameToken(requestToken(request), token)) {
			return reject(reply, 401, 'A valid admin token is required');
		}
	});

	// The startup URL points here: it turns the token in the URL into a cookie
	app.get('/session', async (request, reply) => {
		const given = (request.query as { token?: unknown }).token;
		if (typeof given !== 'string' || !sameToken(given, token)) {
			return reject(reply, 401, 'A valid admin token is required');
		}
		return reply
			.header('set-cookie', `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict`)
			.redirect('/');
	});
};

/** The URL to print at start. It opens a session in the browser. */
export const sessionUrl = (baseUrl: string, token: string): string =>
	`${baseUrl.replace(/\/$/, '')}/session?token=${token}`;
