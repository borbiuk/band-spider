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
}

/** The message of a caught value: `message` of an `Error`, the value as text otherwise. */
export const errorMessage = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

/** A caught value as an `Error`: an `Error` stays the same object, anything else is wrapped. */
export const asError = (error: unknown): Error =>
	error instanceof Error ? error : new Error(String(error));
