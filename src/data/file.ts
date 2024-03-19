import * as fs from 'fs';
import { onlyUnique } from '../common/utils';

// Returns URLs from file
export const readUrlsFromFile = (fileName: string): string[] => {
	const fileContent = fs.readFileSync(fileName, 'utf8');
	return fileContent.split('\n')
		.filter(Boolean)
		.filter((value, index, array) => onlyUnique(value, index, array));
};
