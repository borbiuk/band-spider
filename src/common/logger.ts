import { isArray, isObject } from './utils';

interface ILogger {
	success(...params): void;

	info(...params): void;

	warning(...params): void;

	error(e: Error, ...params): void;
}

class Logger implements ILogger {
	private readonly color = require('node-color-log');

	constructor(
		private readonly enable = true,
		private readonly zeroErrorPolicy = false
	) {
	}

	public success(...params): void {
		if (!this.enable) {
			return;
		}

		const message = this.getText(...params);
		this.color.color('green').log(`SUCCESS:${message}`);
	}

	public info(...params): void {
		if (!this.enable) {
			return;
		}

		const message = this.getText(...params);
		this.color.color('blue').log(`INFO:${message}`);
	}

	public warning(...params): void {
		if (!this.enable) {
			return;
		}

		const message = this.getText(...params);
		this.color.color('yellow').log(`WARNING:${message}`);
	}

	public error(e: Error, ...params): void {
		if (!this.enable) {
			return;
		}

		const message = this.getText(...params);
		this.color.color('red').log(`ERROR:${message}`);
		this.color.color('red').log(e);

		if (this.zeroErrorPolicy) {
			throw e;
		}
	}

	private getText(...params: any[]): string {
		let message = '';

		for (let param of params) {
			if (isArray(param)) {
				message += this.getArrayText(param);
			}
			else if (isObject(param)) {
				message += this.getObjectText(param);
			}
			else {
				message += '    --> ' + param + '\n';
			}
		}

		return message;
	}

	private getArrayText(value: []): string {
		let message = `\n    --> ${value.length} [\n`
		value.forEach(x => {
			message += `\t${this.getText(x)}`
		});
		message += '\t]';

		return message + '\n';
	}

	private getObjectText(value: object): string {
		return '    --> ' + JSON.stringify(value, null, 2).split('\n').join('\n\t') + '\n';
	}
}

export const logger: ILogger = new Logger();
