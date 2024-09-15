import { AccountTabData } from './account-tab-data';

export interface AccountPageData {
	url: string,
	collection: AccountTabData,
	wishlist: AccountTabData,
	followers: AccountTabData,
	following: AccountTabData,
	errors: Error[]
}
