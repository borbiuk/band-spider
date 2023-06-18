import { Item } from './base/item';

export interface Album extends Item{
	id: number;
	url: string;
}
