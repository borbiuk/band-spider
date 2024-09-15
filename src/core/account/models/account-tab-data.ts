export interface AccountTabData {
	total: number,
	urls: string[],
	error?: Error
}

export const defaultPageReadResult: AccountTabData = { total: 0, urls: [] };
export const getPageReadErrorResult = (error: Error): AccountTabData => ({ ...defaultPageReadResult, error });
