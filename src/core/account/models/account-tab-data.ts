export interface AccountTabData {
	total: number,
	urls: string[],
	error?: Error
}

export const defaultAccountTabData: AccountTabData = { total: 0, urls: [] };
export const errorAccountTabData = (error: Error): AccountTabData => ({ ...defaultAccountTabData, error });
