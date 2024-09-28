import { execSync } from 'child_process';
// import * as process from 'node:process';
import { logger, LogSource } from '../../common/logger';
import { delay, isNullOrUndefined, logMessage } from '../../common/utils';

export class ProxyClient {
	private static instance: ProxyClient;

	private readonly locations: number[] = [
		1, 2, 4, 5, 6, 7, 8, 9,
		11, 12, 15, 16, 18, 19,
		21, 22, 23, 25, 26, 29,
		31, 32, 33, 34, 35, 36, 45,
		53, 54, 56, 70, 71, 74, 75, 78, 79,
		85, 86, 87, 89, 90, 92, 94, 95, 96, 99,
		102, 103, 104, 106, 110, 118, 119,
		120, 121, 122, 124, 126, 127, 129, 130, 134,
		145, 146, 147, 150, 153, 155, 157,
		161, 165, 166, 168, 169, 172, 178,
		181, 182, 184, 187, 188, 189,
		201, 202, 203, 204, 207, 210, 211, 212
	];

	private readonly timeout: number = 30_000;

	private lastChangeTime: number = null;
	private isProgress: boolean = false;
	private availableIndices: number[] = []

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

	public async changeIp(isFirst: boolean = false): Promise<boolean> {
		if (!isFirst) {
			if (this.isProcessing) {
				return false;
			}

			if (!isNullOrUndefined(this.lastChangeTime)) {
				const timeDiff = (this.nowTime - this.lastChangeTime) / 1000;
				if (timeDiff < 15) {
					return false;
				}
			}
		}

		this.isProgress = true;

		const index = this.getNextId();
		const id = this.locations[index];

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

			logger.debug(logMessage(LogSource.Proxy, `IP Changing to ID ${id} [${index + 1}/${this.locations.length}]`));
			const commandOutput = execSync(`expresso connect --change ${id} --timeout ${this.timeout}`, { encoding: 'utf8' });
			this.lastChangeTime = this.nowTime;
			logger.debug(logMessage(LogSource.Proxy, `IP Changed for ID ${id}: ${commandOutput}`));
		} catch (error) {
			logger.error(error, logMessage(LogSource.Proxy, `IP Changing failed for ID ${id}: ${error.stdout}`));
			try {
				await delay(60_000);
				const commandOutput = execSync(`expresso connect --change ${id} --timeout ${this.timeout}`, { encoding: 'utf8' });
				this.lastChangeTime = this.nowTime;
				logger.debug(logMessage(LogSource.Proxy, `IP Changed for ID ${id}: ${commandOutput}`));
			}
			catch (error) {
				logger.error(error, logMessage(LogSource.Proxy, `IP Changing failed for ID ${id}: ${error.stdout}`));
			}
		} finally {
			this.isProgress = false;
		}

		return true;
	}

	/**
	 * Returns a random, non-repeating index from the `locations` array.
	 *
	 * This method ensures that each index in the `locations` array is returned exactly once
	 * before resetting. It keeps track of available indices in the `availableIndices` array.
	 * Once all indices have been used, it resets the list of available indices and starts over.
	 *
	 * @returns {number} A unique random index from the `locations` array.
	 */
	private getNextId(): number {
		if (this.availableIndices.length === 0) {
			this.availableIndices = Array.from({ length: this.locations.length }, (_, i) => i);
		}

		const randomIndex = Math.floor(Math.random() * this.availableIndices.length);
		this.availableIndices.splice(randomIndex, 1);

		return this.availableIndices[randomIndex];
	}
}
