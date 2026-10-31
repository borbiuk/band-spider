import { Browser, HTTPResponse, LaunchOptions, Page } from 'puppeteer';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { errorColor, logger, LogSource, speedColor, successColor } from '../common/logger';
import { ProcessingQueue, QueueEvent } from '../common/processing-queue';
import { RateLimitedError, RateLimitGate } from '../common/rate-limit-gate';
import { isAccountUrl, isItemUrl, isNullOrUndefined, logMessage } from '../common/utils';
import { BandDatabase } from '../data/db';
import { BandSpiderOptions } from '../index';
import { processAccount } from './account/account-handler';
import { processItem } from './item/item-handler';
import { ProxyClient } from './proxy/proxy-client';

export enum UrlType {
	Account = 'account',
	Item = 'item',
}

enum UrlResult {
	Processed,
	Failed,
	/** Bandcamp answered HTTP 429: the URL is not counted as failed and is tried again after the pause. */
	RateLimited,
}

// The page is replaced often to free the memory of the renderer, the whole browser rarely.
const PAGE_RECREATE_INTERVAL = 1;
const BROWSER_RELAUNCH_INTERVAL = 500;

export class BandSpider {
	private readonly statistic = {
		processed: 0,
		skipped: 0,
		failed: 0,
		rateLimited: 0,
		start: null
	};

	private database: BandDatabase;

	// one pause for all workers after HTTP 429
	private readonly rateLimitGate = new RateLimitGate();

	public async run(
		{
			concurrencyBrowsers,
			headless,
			type,
			docker,
		}: BandSpiderOptions
	): Promise<void> {
		puppeteer.use(StealthPlugin());

		// init database
		logger.debug('DB synchronizing...')
		this.database = await BandDatabase.initialize();
		logger.debug('DB synchronized!');

		logger.debug('DB preparing ...');
		await this.database.account.resetAllBusy();
		await this.database.item.resetAllBusy();
		logger.debug('DB ready!');

		// init queue
		logger.debug('Queue init...');
		const queue: ProcessingQueue = new ProcessingQueue(
			await this.getInitialUrlsToProcess(type),
			this.database
		);
		logger.debug('Queue ready!');

		// change IP
		await ProxyClient.initialize.changeIp(true);

		// configure browsers closing on exit
		const browsersList: { [id: number]: Browser } = {};
		process.on('SIGINT', async () => {
			await Promise.allSettled(Object.values(browsersList).map(x => x.close()));
			logger.warn('Browsers closed');
			process.exit();
		});

		const recreateBrowser = async (id: number, safe = true): Promise<Page> => {
			try {
				const existed = browsersList[id];
				if (!isNullOrUndefined(existed)) {
					await existed.close();
					logger.debug(
						logMessage(LogSource.Browser, `[${String(id).padEnd(2)}] closed!`)
					);
				}

				const browser = await this.getBrowser(docker, headless);
				browsersList[id] = browser;

				logger.debug(
					logMessage(LogSource.Browser, `[${String(id).padEnd(2)}] created!`)
				);
				return await this.getPage(browser, headless, true);
			}
			catch (e) {
				if (!safe) {
					logger.error(e)
					throw e;
				}

				return await recreateBrowser(id, false);
			}

		}

		// closes the page and opens a new one with the same setup in the same browser
		const recreatePage = async (id: number, oldPage: Page): Promise<Page> => {
			try {
				const page = await this.getPage(browsersList[id], headless, false);
				await oldPage.close().catch(() => { });
				return page;
			} catch (e) {
				logger.error(e, logMessage(LogSource.Browser, `[${String(id).padEnd(2)}] page recreation failed, relaunching browser`));
				return await recreateBrowser(id);
			}
		}

		// create jobs
		logger.debug(`${concurrencyBrowsers} Jobs (Browsers) init starting...`);
		const promises: Promise<void>[] = Array.from({ length: concurrencyBrowsers })
			.map(async (_, id: number) => {
				return this.startPageProcessing(
					recreateBrowser,
					recreatePage,
					queue,
					type,
					id,
				);
			});
		logger.debug('Jobs started!');

		// run jobs
		await Promise.all(promises)
	}

	private async startPageProcessing(
		recreateBrowser: (id: number) => Promise<Page>,
		recreatePage: (id: number, page: Page) => Promise<Page>,
		queue: ProcessingQueue,
		type: UrlType,
		id: number,
	) {
		if (isNullOrUndefined(this.statistic.start)) {
			this.statistic.start = new Date().getTime()
		}

		let page = await recreateBrowser(id);

		let i = 0;
		while (true) {
			i++;

			// do not take a URL, nor refill the queue, while the pause after HTTP 429 is active
			await this.rateLimitGate.wait();

			// fill queue
			if (queue.size === 0) {
				await this.enqueueFromDb(queue, type);
				if (queue.size === 0) {
					break;
				}
			}

			// dequeue 
			const event: QueueEvent = await queue.dequeue();
			if (isNullOrUndefined(event)) {
				continue;
			}

			// process
			const result = await this.processUrl(
				event,
				page,
				id,
				// feed new URLs straight into the queue, the DB scan stays as the refill path
				(urls) => urls
					.filter(x => this.isUrlOfType(type, x))
					.forEach(x => queue.enqueue(x)),
			);

			// update statistic
			if (result === UrlResult.Processed) {
				this.statistic.processed++;
				this.rateLimitGate.reportSuccess();
			} else if (result === UrlResult.RateLimited) {
				this.statistic.rateLimited++;
				// not lost: if the queue is full, the next refill from the DB picks it up
				queue.enqueue(event.url);
			} else {
				this.statistic.failed++;
			}

			if ((this.statistic.processed + this.statistic.failed) % 50 === 0) {
				logger.debug(
					logMessage(
						LogSource.Main,
						`Processed: ${successColor(this.statistic.processed).padEnd(4)}; Failed: ${errorColor(this.statistic.failed).padEnd(4)}; Rate limited: ${this.statistic.rateLimited}; Speed: ${speedColor((this.statistic.processed / ((new Date().getTime() - this.statistic.start) / 1000)).toFixed(2)).padEnd(4)}`
							.padStart(240)
					)
				);

				// if (this.statistic.processed * 1.5 < this.statistic.failed) {
				// 	await page.browser().close();
				// 	throw 'No sense to process!';
				// }
			}

			if (i % BROWSER_RELAUNCH_INTERVAL === 0) {
				page = await recreateBrowser(id);
			} else if (i % PAGE_RECREATE_INTERVAL === 0) {
				page = await recreatePage(id, page);
			}
		}

		await page.close();
		logger.info(
			logMessage(LogSource.Browser, `[${String(id).padEnd(2)}] Completed!`)
		);
	}

	private async processUrl(
		event: QueueEvent,
		page: Page,
		pageIndex: number,
		onNewUrls: (urls: string[]) => void,
	): Promise<UrlResult> {
		try {
			let processed = false;
			if (event.type === UrlType.Account) {
				await this.database.account.updateBusy(event.id, true);
				processed = await processAccount(event, this.database, page, pageIndex, onNewUrls);
				if (!processed) {
					await this.database.account.updateFailed(event.id)
				}
				await this.database.account.updateBusy(event.id, false);
			} else if (event.type === UrlType.Item) {
				await this.database.item.updateBusy(event.id, true);
				processed = await processItem(event, this.database, page, pageIndex, onNewUrls);
				if (!processed) {
					await this.database.item.updateFailed(event.id)
				}
				await this.database.item.updateBusy(event.id, false);
			}
			return processed ? UrlResult.Processed : UrlResult.Failed;
		} catch (error) {
			// HTTP 429 is not a failure of the item: only release it, so it stays a candidate
			if (error instanceof RateLimitedError) {
				if (event.type === UrlType.Account) {
					await this.database.account.updateBusy(event.id, false);
				} else if (event.type === UrlType.Item) {
					await this.database.item.updateBusy(event.id, false);
				}
				this.pauseOnRateLimit(error.url, error.retryAfter);
				return UrlResult.RateLimited;
			}

			console.log('\n\n\n\n\n\n\n\nTHIS SHOULD NOT BE HERE !!!!\n\n\n\n\n\n\n\n\n\n\n\n\n\n')
			let source: LogSource = LogSource.Unknown;
			if (event.type === UrlType.Account) {
				source = LogSource.Account;
				await this.database.account.updateFailed(event.id)
				await this.database.account.updateBusy(event.id, false);
			} else if (event.type === UrlType.Item) {
				source = LogSource.Item;
				await this.database.item.updateFailed(event.id)
				await this.database.item.updateBusy(event.id, false);
			}

			if (error.message === 'Page did not exist') {
				logger.warn(
					logMessage(source, `[${String(pageIndex).padStart(2)}] Page did not exist`.padEnd(50), event.url)
				);
				return UrlResult.Processed;
			}

			logger.error(
				error,
				logMessage(source, `[${pageIndex}] Processing failed: ${error.message}`, event.url)
			);

			return UrlResult.Failed;
		}
	}

	/** Starts the shared pause and logs one line when a new pause starts. */
	private pauseOnRateLimit(url: string, retryAfter?: string): void {
		const pause = this.rateLimitGate.trip(retryAfter);
		if (pause.started) {
			logger.warn(
				{ url, status: 429, retryAfter: retryAfter ?? null, pauseSeconds: Math.round(pause.pauseMs / 1000), level: pause.level },
				logMessage(LogSource.Browser, 'HTTP 429, all workers paused')
			);
		}
	}

	/**
	 * Tells if a URL is of the kind this run processes, the same as the `getNotProcessed` filters do:
	 * accounts for the account run, only track URLs for the item run.
	 */
	private isUrlOfType(type: UrlType, url: string): boolean {
		switch (type) {
			case UrlType.Account:
				return isAccountUrl(url);
			case UrlType.Item:
				return isItemUrl(url) && url.toLowerCase().includes('/track/');
			default:
				return false;
		}
	}

	private async getInitialUrlsToProcess(
		type: UrlType,
	): Promise<string[]> {
		switch (type) {
			case UrlType.Account:
				return (await this.database.account.getNotProcessed()).map(({ url }) => url);
			// return ([(await this.database.account.getById(1)).url])
			// return (await this.database.account.getAccountRelated(1)).map(({ url }) => url).reverse()
			case UrlType.Item:
				return (await this.database.item.getNotProcessed()).map(({ url }) => url);
			// return (await this.database.item.getUserItems(1)).map(({ url }) => url)
			default:
				throw new Error('Scrapping Type is invalid!');
		}
	}

	private async enqueueFromDb(
		queue: ProcessingQueue,
		type: UrlType
	): Promise<void> {
		let urls: string[] = await this.getInitialUrlsToProcess(type);
		if (urls.length !== 0) {
			await queue.enqueueButch(urls);
		}
	}

	private async getBrowser(docker: boolean, headless: boolean): Promise<Browser> {
		if (docker) {
			return await puppeteer.connect({
				browserWSEndpoint: 'ws://localhost:3000',
			});
		} else {
			return await puppeteer.launch({
				headless: headless,
				devtools: false,
				ignoreDefaultArgs: [
					'--enable-automation'
				],
				args: [
					'--disable-accelerated-2d-canvas',
					'--disable-background-timer-throttling',
					'--disable-backgrounding-occluded-windows',
					'--disable-breakpad',
					'--disable-client-side-phishing-detection',
					'--disable-component-extensions-with-background-pages',
					'--disable-default-apps',
					'--disable-dev-shm-usage',
					'--disable-extensions',
					'--disable-gpu',
					'--disable-infobars',
					'--disable-popup-blocking',
					'--disable-setuid-sandbox',
					'--dns-server=1.1.1.1',
					'--ignore-certificate-errors',
					'--incognito',
					'--no-first-run',
					'--no-sandbox',
					'--no-zygote',
					'--performance',
					'--window-size=1200,800',
					//'--single-process',
				]
			} as LaunchOptions);
		}
	}

	private async getPage(
		browser: Browser,
		headless: boolean,
		reuseFirstPage: boolean,
	): Promise<Page> {
		const pages = reuseFirstPage ? await browser.pages() : [];
		const page = isNullOrUndefined(pages) || pages.length === 0
			? await browser.newPage()
			: pages[0];

		// response handling
		page.on('response', (httpResponse: HTTPResponse) => {
			if (httpResponse.status() === 429) {
				this.pauseOnRateLimit(httpResponse.url(), httpResponse.headers()['retry-after']);
			}
		});

		// request filtering
		if (headless) {
			await page.setCacheEnabled(false);

			await page.setRequestInterception(true);
			page.on('request', (request) => {
				if ([
					'font',
					'image',
					'media'
				].includes(request.resourceType())) {
					request.abort();
					return;
				}

				const url = request.url();

				// Account tabs are read from the fan collection API, so every method of it is needed.
				if (request.method() === 'POST' && !url.startsWith('https://bandcamp.com/api/fancollection/1/')) {
					request.abort();
					return;
				}

				if (
					url.includes('recaptcha')
					|| url.includes('gstatic.com')
					|| url.includes('googletagmanager.com')
					|| url.includes('google.com')
					|| url.includes('bandcamp.com/api/currency_data')
				) {
					request.abort();
					return;
				}

				request.continue();
			});
		}

		return page;
	}

}
