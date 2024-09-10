import { execSync } from 'child_process';
// import * as process from 'node:process';
import { logger, LogSource } from '../../common/logger';
import { isNullOrUndefined, logMessage } from '../../common/utils';

export class ProxyClient {
	private static instance: ProxyClient;

	private readonly locations: number[] = [
		26, 168, 75, 19, 166, 202, 54, 165, 25, 18, 172,
		9, 161, 95, 1, 74, 70, 2, 204, 94, 155, 6, 71,
		207, 79, 181, 169, 45, 87, 32, 153, 103, 8, 104,
		150, 5, 53, 178, 15, 90, 212, 4, 16, 23, 203,
		201, 11, 182, 157, 29, 7, 210, 92, 86, 129, 22,
		211, 35, 89, 33, 106, 96, 78, 85, 34, 102, 31,
		21, 36, 122, 130, 56, 184, 189, 147, 12, 99, 110,
		134, 119, 124, 126, 118, 121, 127, 187, 188,
		146, 120, 145
		// 136 Georgia
		// 186 Belarus 
	];

	private readonly timeout: number = 30_000;

	private lastLocationIndex: number = null;
	private lastChangeTime: number = null;
	private isProgress: boolean = false;

	private constructor() {
	}

	public static get initialize(): ProxyClient {
		if (isNullOrUndefined(this.instance)) {
			this.instance = new ProxyClient();
		}

		return this.instance;
	}

	public get isProcessing(): boolean {
		return this.isProgress;
	}

	private get nowTime(): number {
		return new Date().getTime();
	}

	public changeIp(): boolean {
		if (this.isProcessing) {
			return false;
		}

		if (!isNullOrUndefined(this.lastChangeTime)) {
			const timeDiff = (this.nowTime - this.lastChangeTime) / 1000;
			if (timeDiff < 15) {
				return false;
			}
		}

		this.isProgress = true;

		this.lastLocationIndex = isNullOrUndefined(this.lastLocationIndex) || this.lastLocationIndex === this.locations.length - 1
			? 0
			: this.lastLocationIndex + 1;

		const id = this.locations[this.lastLocationIndex];
		try {
			// clear DNS cache on mac
			// logger.warn(logMessage(LogSource.Proxy, 'DNC cache clearing...'));
			// switch (process.platform) {
			//	case 'linux':
			//		execSync('sudo resolvectl flush-caches', { encoding: 'utf8' });
			//		break;
			//	case 'darwin':
			//		execSync('sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder', { encoding: 'utf8' });
			// }
			// logger.info(logMessage(LogSource.Proxy, 'DNC cache cleared!'));

			logger.warn(logMessage(LogSource.Proxy, `IP Changing to ID ${id} and index [${this.lastLocationIndex}/${this.locations.length}]`));
			const commandOutput = execSync(`expresso connect --change ${id} --timeout ${this.timeout}`, { encoding: 'utf8' });
			this.lastChangeTime = this.nowTime;

			logger.info(logMessage(LogSource.Proxy, `IP Changed for ID ${id}: ${commandOutput}`));
		} catch (error) {
			logger.error(error, logMessage(LogSource.Proxy, `IP Changing failed for ID ${id}: ${error.stdout}`));
		} finally {
			this.isProgress = false;
		}

		return true;
	}
}
