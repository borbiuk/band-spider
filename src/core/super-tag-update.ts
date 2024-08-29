import Fuse from 'fuse.js';
import { logger } from '../common/logger';
import { BandDatabase } from '../data/db';
import { BandSpiderOptions } from '../index';

export class SuperTagUpdate {
	private database: BandDatabase;

	public async run({}: BandSpiderOptions): Promise<void> {
		logger.info('DB creating...')
		this.database = await BandDatabase.initialize();
		logger.info('DB created');

		logger.info('Tags search...');
		const superTags = await this.database.superTag.all();

		const fuse = new Fuse(superTags, {
			keys: ['name'],
			threshold: 0.3, // Adjust threshold based on how strict/loose you want the matching
		});

		let page = 1;
		const take = 500;

		let tags = await this.database.tag.getAll(page, take)
		while (tags.length > 0) {
			const tag = tags.shift();

			const normalizedTagName = this.normalizeTagName(tag.name);

			// Find the best matching super tag
			const result = fuse.search(normalizedTagName, { limit: 3 });
			if (result.length > 0) {
				for( let i = 0; i < result.length; i++) {
					const bestMatchSuperTag = result[i].item;

					if (await this.database.superTag.addTag(bestMatchSuperTag.id, tag.id)) {
						logger.info(`Linked tag "${tag.name}" to super tag "${bestMatchSuperTag.name}"`);
					}
				}
			} else {
				logger.warn(`No match found for tag "${tag.name}"`);
			}

			// fill tags
			if (tags.length === 0) {
				logger.info('Tags search...');
				tags = await this.database.tag.getAll(page++, take)
			}
		}
	}

	private normalizeTagName(name: string): string {
		return name.replace(/[-_]/g, '').toLowerCase();
	}
}
