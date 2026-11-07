/** The page does not exist: HTTP 404, or Bandcamp rendered its "not found" page. */
export class PageNotFoundError extends Error {
	constructor() {
		super('Page did not exist');
	}
}

/** A page request was answered with a status that is not 200, 404 or 429. */
export class HttpStatusError extends Error {
	constructor(
		public readonly status: number,
		public readonly url: string,
	) {
		super(`HTTP ${status}: ${url}`);
	}
}

/**
 * An API refused a request. A list that was cut short must not be saved as a complete one, so this
 * error is not kept inside one field: it fails the whole page.
 */
export class ApiRefusedError extends Error {
	constructor(message: string, public readonly status?: number) {
		super(message);
	}
}

/** A request did not get an answer: the connection was refused, reset, and so on. `code` is the code of the reason, like `ECONNRESET`. */
export class NetworkError extends Error {
	constructor(message: string, public readonly code: string, options?: ErrorOptions) {
		super(message, options);
	}
}

/**
 * True for an error that is likely about the connection, not about the page: a network error, a
 * timeout, HTTP 403 or a 5xx status. A failing proxy or a blocked IP gives these for every page.
 */
export const isConnectionFailure = (error: unknown): boolean =>
	error instanceof NetworkError
	|| (error instanceof HttpStatusError && (error.status === 403 || error.status >= 500))
	|| (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError'));

/** The message of a caught value: `message` of an `Error`, the value as text otherwise. */
export const errorMessage = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

/** A caught value as an `Error`: an `Error` stays the same object, anything else is wrapped. */
export const asError = (error: unknown): Error =>
	error instanceof Error ? error : new Error(String(error));

/** Why a URL failed: a short stable key and the message of the error. */
export interface FailureReport {
	/** `http:<status>`, `api:<status>`, `timeout`, `network:<code>`, `save`, `scrape`. */
	key: string;
	message: string;
	url: string;
}

/** Where in the processing of a URL the error came from. */
export type FailureStage = 'scrape' | 'save';

/** The key of a failure. It names the HTTP status when there is one, so the admin can count the reasons. */
export const failureKey = (error: unknown, stage: FailureStage = 'scrape'): string => {
	if (stage === 'save') {
		return 'save';
	}
	if (error instanceof HttpStatusError) {
		return `http:${error.status}`;
	}
	if (error instanceof ApiRefusedError) {
		return error.status === undefined ? 'api' : `api:${error.status}`;
	}
	if (error instanceof NetworkError) {
		return `network:${error.code}`;
	}
	if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
		return 'timeout';
	}
	return 'scrape';
};
