import * as fs from 'fs';
import { onlyUnique } from '../common/utils';

export const readUrlsFromFile = (filename): string[] => {
	const fileContent = fs.readFileSync(filename, 'utf8');
	return fileContent.split('\n')
		.filter(Boolean)
		.filter((value, index, array) => onlyUnique(value, index, array));
};
