import { ItemTabData } from './item-tab-data';

export interface ItemPageData {
	url: string,
	accounts: ItemTabData<string[]>,
	tags: ItemTabData<string[]>,
	releaseDate: ItemTabData<Date>,
	album?: ItemTabData<string>,
	tracks?: ItemTabData<string[]>,
	imageUrl: ItemTabData<string>,
	errors: Error[]
}
