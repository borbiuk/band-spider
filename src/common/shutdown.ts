import { logger, LogSource } from './logger';
import { logMessage } from './utils';

/** Exit codes after a stop by signal, as a shell reports them: 128 + the signal number. */
export const SIGNAL_EXIT_CODES = {
	SIGINT: 130,
	SIGTERM: 143,
} as const;

type StopSignal = keyof typeof SIGNAL_EXIT_CODES;

const SIGNALS = Object.keys(SIGNAL_EXIT_CODES) as StopSignal[];

/**
 * Asks the run to stop on the first SIGINT or SIGTERM: the returned signal is aborted, so the
 * workers finish the current URL and stop, and the process exits with the matching exit code.
 * A second signal exits at once, also during a long pause after HTTP 429. It exits with
 * `process.exit()`, so Puppeteer still kills the browsers it launched.
 */
export function stopOnSignals(): AbortSignal {
	const controller = new AbortController();
	const handlers = new Map<StopSignal, () => void>();

	const stopNow = (): void => {
		process.exit();
	};

	for (const name of SIGNALS) {
		handlers.set(name, () => {
			handlers.forEach((handler, other) => process.removeListener(other, handler));
			SIGNALS.forEach(other => process.once(other, stopNow));

			process.exitCode = SIGNAL_EXIT_CODES[name];
			logger.warn(logMessage(LogSource.Main, `${name}: stopping after the current URL, send it again to stop now`));
			controller.abort();
		});
	}
	handlers.forEach((handler, name) => process.once(name, handler));

	return controller.signal;
}
