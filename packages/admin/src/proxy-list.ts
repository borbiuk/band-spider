import { PoolEntry } from './config';

/** A line that could not be read. The message never has the line text, because it holds a password. */
export interface ProxyListError {
	line: number;
	message: string;
}

export interface ParsedProxyList {
	entries: PoolEntry[];
	errors: ProxyListError[];
	/** Lines with a host:port that an earlier line already gave. The first one is kept. */
	duplicateLines: number[];
}

const FORMAT_HELP = 'expected host:port:username:password or http://username:password@host:port';
const HOST = /^[A-Za-z0-9.-]+$/;
const URL_FORM = /^http:\/\/([^:@/]*):([^@/]*)@([^:@/]*):([^:@/]*)\/?$/i;

type LineResult = { entry: PoolEntry } | { error: string };

const build = (host: string, portText: string, username: string, password: string): LineResult => {
	if (host === '') {
		return { error: 'the host is empty' };
	}
	if (!HOST.test(host)) {
		return { error: 'the host has bad characters' };
	}
	const port = /^\d{1,5}$/.test(portText) ? Number(portText) : 0;
	if (port < 1 || port > 65535) {
		return { error: 'the port must be a number from 1 to 65535' };
	}
	if (username === '') {
		return { error: 'the user name is empty' };
	}
	if (password === '') {
		return { error: 'the password is empty' };
	}
	return { entry: { host: host.toLowerCase(), port, username, password } };
};

const parseUrlForm = (match: RegExpExecArray): LineResult => {
	try {
		return build(match[3], match[4], decodeURIComponent(match[1]), decodeURIComponent(match[2]));
	} catch {
		return { error: 'the user name or the password has a bad % code' };
	}
};

/** The password may have colons, so everything after the third colon is the password. */
const parseLine = (line: string): LineResult => {
	if (/^https?:\/\//i.test(line)) {
		const match = URL_FORM.exec(line);
		return match ? parseUrlForm(match) : { error: FORMAT_HELP };
	}
	const parts = line.split(':');
	if (parts.length < 4) {
		return { error: FORMAT_HELP };
	}
	return build(parts[0].trim(), parts[1].trim(), parts[2].trim(), parts.slice(3).join(':').trim());
};

/**
 * Reads a proxy list: one proxy per line, as host:port:username:password (the Webshare export)
 * or as http://username:password@host:port. Empty lines and lines that start with # are ignored.
 */
export const parseProxyList = (text: string): ParsedProxyList => {
	const entries: PoolEntry[] = [];
	const errors: ProxyListError[] = [];
	const duplicateLines: number[] = [];
	const seen = new Set<string>();
	text.split(/\r\n|\n|\r/).forEach((raw, index) => {
		const line = raw.trim();
		if (line === '' || line.startsWith('#')) {
			return;
		}
		const lineNumber = index + 1;
		const result = parseLine(line);
		if ('error' in result) {
			errors.push({ line: lineNumber, message: result.error });
			return;
		}
		const key = `${result.entry.host}:${result.entry.port}`;
		if (seen.has(key)) {
			duplicateLines.push(lineNumber);
			return;
		}
		seen.add(key);
		entries.push(result.entry);
	});
	return { entries, errors, duplicateLines };
};
