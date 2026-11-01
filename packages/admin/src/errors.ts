/** An error that the API shows with an HTTP status. */
export class AdminError extends Error {
	constructor(message: string, readonly status: number) {
		super(message);
		this.name = 'AdminError';
	}
}

export const notFound = (message: string): AdminError => new AdminError(message, 404);
export const conflict = (message: string): AdminError => new AdminError(message, 409);
