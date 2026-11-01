import { z } from 'zod';

// Errors are sent as message strings, an Error object does not survive JSON.

// A date goes through JSON as an ISO string. It is used with nullable(), which checks null first,
// so a null date does not become 1970.
const dateSchema = z.coerce.date();

const accountTabDataSchema = z.object({
	total: z.number(),
	urls: z.array(z.string()),
	complete: z.boolean(),
	stoppedAtMark: z.boolean().optional(),
	error: z.string().optional(),
});

export const accountPageDataSchema = z.object({
	url: z.string(),
	collection: accountTabDataSchema,
	wishlist: accountTabDataSchema,
	followers: accountTabDataSchema,
	following: accountTabDataSchema,
	errors: z.array(z.string()),
});
export type AccountPageDataDto = z.infer<typeof accountPageDataSchema>;

const itemTabDataSchema = <T extends z.ZodType>(data: T) => z.object({
	data,
	error: z.string().optional(),
});

export const itemPageDataSchema = z.object({
	url: z.string(),
	accounts: itemTabDataSchema(z.array(z.string()).nullable()),
	tags: itemTabDataSchema(z.array(z.string()).nullable()),
	releaseDate: itemTabDataSchema(dateSchema.nullable()),
	album: itemTabDataSchema(z.string().nullable()).optional(),
	tracks: itemTabDataSchema(z.array(z.string()).nullable()).optional(),
	imageUrl: itemTabDataSchema(z.string().nullable()),
	errors: z.array(z.string()),
});
export type ItemPageDataDto = z.infer<typeof itemPageDataSchema>;
