import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseProxyList } from '../proxy-list';

describe('parseProxyList', () => {
	it('reads the Webshare file with CRLF line endings', () => {
		const { entries, errors, duplicateLines } = parseProxyList('10.0.0.1:6014:user1:pass1\r\n10.0.0.2:6641:user1:pass1\r\n');
		assert.deepEqual(entries, [
			{ host: '10.0.0.1', port: 6014, username: 'user1', password: 'pass1' },
			{ host: '10.0.0.2', port: 6641, username: 'user1', password: 'pass1' },
		]);
		assert.deepEqual(errors, []);
		assert.deepEqual(duplicateLines, []);
	});

	it('reads LF lines, trims spaces and ignores empty lines and comments', () => {
		const { entries, errors } = parseProxyList('# my proxies\n\n  10.0.0.1:80:u:p  \n   \n# 10.0.0.9:80:u:p\n10.0.0.2:81:u:p');
		assert.deepEqual(entries.map(entry => `${entry.host}:${entry.port}`), ['10.0.0.1:80', '10.0.0.2:81']);
		assert.deepEqual(errors, []);
	});

	it('reads the URL form and decodes a percent-encoded user name and password', () => {
		const { entries, errors } = parseProxyList('http://user1:p%40ss@Proxy.Example.com:8080\nhttp://u:p@10.0.0.3:80/');
		assert.deepEqual(entries, [
			{ host: 'proxy.example.com', port: 8080, username: 'user1', password: 'p@ss' },
			{ host: '10.0.0.3', port: 80, username: 'u', password: 'p' },
		]);
		assert.deepEqual(errors, []);
	});

	it('keeps colons inside the password', () => {
		assert.equal(parseProxyList('10.0.0.1:80:u:pa:ss').entries[0].password, 'pa:ss');
	});

	it('reports a bad port, missing parts and bad URLs with line numbers', () => {
		const text = [
			'10.0.0.1:0:u:p', // line 1
			'10.0.0.1:70000:u:p', // line 2
			'10.0.0.1:abc:u:p', // line 3
			':80:u:p', // line 4
			'10.0.0.1:80::p', // line 5
			'10.0.0.1:80:u:', // line 6
			'10.0.0.1:80:u', // line 7
			'http://u@10.0.0.1:80', // line 8
			'http://u:p@10.0.0.1', // line 9
			'http://u:%zz@10.0.0.1:80', // line 10
			'10.0.0.5:80:u:p', // line 11, good
		].join('\n');
		const { entries, errors } = parseProxyList(text);
		assert.deepEqual(errors.map(error => error.line), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
		assert.equal(entries.length, 1);
		assert.match(errors[0].message, /port/);
		assert.match(errors[3].message, /host/);
		assert.match(errors[4].message, /user name/);
		assert.match(errors[5].message, /password/);
	});

	it('never puts the line or a password in an error', () => {
		const { errors } = parseProxyList('10.0.0.1:0:user-x:secret-pass\nhttp://u:secret-pass@10.0.0.1\n10.0.0.1:80:u');
		assert.equal(errors.length, 3);
		assert.doesNotMatch(JSON.stringify(errors), /secret-pass|user-x|10\.0\.0\.1/);
	});

	it('keeps the first line of a host:port and reports the others', () => {
		const { entries, duplicateLines } = parseProxyList('10.0.0.1:80:a:1\n10.0.0.2:80:a:1\nHTTP://b:2@10.0.0.1:80\n10.0.0.1:80:c:3');
		assert.equal(entries.length, 2);
		assert.equal(entries[0].username, 'a');
		assert.deepEqual(duplicateLines, [3, 4]);
	});

	it('gives nothing for an empty text', () => {
		assert.deepEqual(parseProxyList(''), { entries: [], errors: [], duplicateLines: [] });
	});
});
