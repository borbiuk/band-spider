import { execSync } from 'child_process';
import { logger, LogSource } from '../../common/logger';
import { isNullOrUndefined, logMessage } from '../../common/utils';

export class ProxyClient {
	private static instance: ProxyClient;

	private readonly ids: number[] = [1, 2, 4, 5, 6, 7, 8, 9, 90, 15, 16, 18, 19, 22, 25, 26, 29, 35, 45, 53, 54, 70, 71, 74, 75, 79, 92, 94, 95, 103, 104, 150, 153, 155, 157, 161, 165, 166, 168, 169, 172, 178, 181, 182, 202, 204, 207, 210, 211, 212,];

	private lastIndex: number = null;
	private lastChangeTime: Date = null;

	private constructor() {
	}

	public static get initialize(): ProxyClient {
		if (isNullOrUndefined(this.instance)) {
			this.instance = new ProxyClient();
		}

		return this.instance;
	}

	public get isProcessing(): boolean {
		if (isNullOrUndefined(this.lastChangeTime)) {
			return false;
		}

		const timeDiff = (this.now.getTime() - this.lastChangeTime.getTime()) / 1000;
		return timeDiff < 10;
	}

	private get now(): Date {
		return new Date();
	}

	public changeIp(): boolean {
		if (this.isProcessing) {
			return false;
		}

		this.lastChangeTime = this.now;

		this.lastIndex = isNullOrUndefined(this.lastIndex) || this.lastIndex - 1 === this.ids.length
			? 0
			: this.lastIndex + 1;

		const id = this.ids[this.lastIndex];
		try {
			logger.info(logMessage(LogSource.Proxy, 'IP Changing'));
			const commandOutput = execSync(`expresso connect -c ${id}`, { encoding: 'utf8' });
			logger.info(logMessage(LogSource.Proxy, `IP Changed: ${commandOutput}`));
		} catch (e) {
			logger.error(e, logMessage(LogSource.Proxy, 'IP Changing failed'));
		}

		return true;
	}
}
