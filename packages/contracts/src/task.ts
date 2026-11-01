import { z } from 'zod';

/** Same values as UrlType in core. The contracts package does not depend on core. */
export const urlTypeSchema = z.enum(['account', 'item']);
export type UrlTypeDto = z.infer<typeof urlTypeSchema>;

export const releaseReasonSchema = z.enum(['rateLimited', 'failed', 'notFound']);
export type ReleaseReasonDto = z.infer<typeof releaseReasonSchema>;

/** Where the last complete read of each tab began. A tab without a value was never read to its end. */
export const accountScanMarksSchema = z.object({
	collection: z.string().nullable().optional(),
	wishlist: z.string().nullable().optional(),
	followers: z.string().nullable().optional(),
	following: z.string().nullable().optional(),
});
export type AccountScanMarksDto = z.infer<typeof accountScanMarksSchema>;

export const crawlTaskSchema = z.object({
	id: z.number().int(),
	url: z.string(),
	type: urlTypeSchema,
	marks: accountScanMarksSchema.optional(),
});
export type CrawlTaskDto = z.infer<typeof crawlTaskSchema>;
