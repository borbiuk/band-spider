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

class Logger {
	private readonly color = require('node-color-log');

	constructor(
		private readonly options: LoggerOptions
	) {
	}

	public success(...params: any[]): void {
		if (this.isLoggingAvailable(LogLevel.Success)) {
			return;
		}

		this.color.success(params);
	}

	public info(...params: any[]): void {
		if (this.isLoggingAvailable(LogLevel.Info)) {
			return;
		}

		this.color.info(params);
	}

	public warning(...params: any[]): void {
		if (this.isLoggingAvailable(LogLevel.Warning)) {
			return;
		}

		this.color.warn(params);
	}

	public error(error: Error, ...params: any[]): void {
		if (this.isLoggingAvailable(LogLevel.Error)) {
			return;
		}

		this.color.error({ ...params, error});

		if (this.options.zeroErrorPolicy) {
			throw error;
		}
	}
	
	private isLoggingAvailable(logLevel: LogLevel): boolean {
		return !this.options.enable || this.options.level < logLevel;
	}
}

export const logger: Logger = new Logger({
	enable: true,
	level: LogLevel.Error,
	zeroErrorPolicy: false
} as LoggerOptions);
