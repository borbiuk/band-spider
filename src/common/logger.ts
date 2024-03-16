import { isArray, isObject } from './utils';

export interface ILogger {
	success(...params: any[]): void;

	info(...params: any[]): void;

	warning(...params: any[]): void;

	error(e: Error, ...params: any[]): void;
}

export enum LogLevel {
	Success = 0,
	Info = 1,
	Warning = 2,
	Error = 3
}

export interface LoggerOptions {
	enable: boolean;
	level: LogLevel;
	zeroErrorPolicy: boolean
}

class Logger implements ILogger {
	private readonly color = require('node-color-log');

	constructor(
		private readonly options: LoggerOptions
	) {
	}

	public success(...params: any[]): void {
		if (!this.options.enable || this.options.level < LogLevel.Success) {
			return;
		}

		const message = this.getText(...params);
		this.color.color('green').log(`SUCCESS:${message}`);
	}

	public info(...params: any[]): void {
		if (!this.options.enable || this.options.level < LogLevel.Info) {
			return;
		}

		const message = this.getText(...params);
		this.color.color('blue').log(`INFO:${message}`);
	}

	public warning(...params: any[]): void {
		if (!this.options.enable|| this.options.level < LogLevel.Warning) {
			return;
		}

		const message = this.getText(...params);
		this.color.color('yellow').log(`WARNING:${message}`);
	}

	public error(error: Error, ...params: any[]): void {
		if (!this.options.enable || this.options.level < LogLevel.Error) {
			return;
		}

		const message = this.getText(...params);
		this.color.color('red').error(`ERROR:${message}`);
		this.color.color('red').error(error);

		if (this.options.zeroErrorPolicy) {
			throw error;
		}
	}

	private getText(...params: any[]): string {
		let message = '\n';

		for (let param of params) {
			if (isArray(param)) {
				message += this.getArrayText(param);
			}
			else if (isObject(param)) {
				message += this.getObjectText(param);
			}
			else {
				message += '\t--> ' + param + '\n';
			}
		}

		return message;
	}

	private getArrayText(value: []): string {
		let message = `\t--> ${value.length} [\n`
		value.forEach(x => {
			message += `\t\t${this.getText(x)}`
		});
		message += '\t]';

		return message;
	}

	private getObjectText(value: object): string {
		return '\t--> ' + JSON.stringify(value, null, 2).split('\n').join('\n\t') + '\n';
	}
}

export const logger: ILogger = new Logger({
	enable: true,
	level: LogLevel.Info,
	zeroErrorPolicy: false
} as LoggerOptions);
