import { z } from 'zod';

const accountTabStatisticSchema = z.object({
	total: z.number(),
	allScraped: z.boolean(),
	newRecords: z.number(),
	newRelations: z.number(),
	newUrls: z.array(z.string()),
});

export const accountPageStatisticSchema = z.object({
	collection: accountTabStatisticSchema,
	wishlist: accountTabStatisticSchema,
	followers: accountTabStatisticSchema,
	following: accountTabStatisticSchema,
});
export type AccountPageStatisticDto = z.infer<typeof accountPageStatisticSchema>;

const itemTabStatisticSchema = z.object({
	total: z.number(),
	newRecords: z.number(),
	newRelations: z.number(),
});

export const itemPageStatisticSchema = z.object({
	accounts: itemTabStatisticSchema,
	tags: itemTabStatisticSchema,
	releaseDate: itemTabStatisticSchema,
	album: itemTabStatisticSchema,
	tracks: itemTabStatisticSchema,
	newUrls: z.array(z.string()),
});
export type ItemPageStatisticDto = z.infer<typeof itemPageStatisticSchema>;
