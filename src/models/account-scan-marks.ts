/**
 * Where the last complete read of each tab of an account began: the URL of a record from the first
 * (newest) batch, or null when the tab was empty. A tab without a value was never read to its end.
 */
export interface AccountScanMarks {
	collection?: string | null;
	wishlist?: string | null;
	followers?: string | null;
	following?: string | null;
}
