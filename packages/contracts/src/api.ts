import { z } from 'zod';
import { accountPageDataSchema, itemPageDataSchema } from './page-data';
import { accountPageStatisticSchema, itemPageStatisticSchema } from './statistic';
import { crawlTaskSchema, releaseReasonSchema, urlTypeSchema } from './task';

// Request and response bodies of the DB service. One pair of schemas per endpoint.

export const claimRequestSchema = z.object({
	type: urlTypeSchema,
	count: z.number().int().positive(),
	newestFirst: z.boolean(),
});
export type ClaimRequest = z.infer<typeof claimRequestSchema>;

export const claimResponseSchema = z.object({
	tasks: z.array(crawlTaskSchema),
});
export type ClaimResponse = z.infer<typeof claimResponseSchema>;

export const saveItemRequestSchema = z.object({
	task: crawlTaskSchema,
	data: itemPageDataSchema,
});
export type SaveItemRequest = z.infer<typeof saveItemRequestSchema>;

export const saveItemResponseSchema = z.object({
	statistic: itemPageStatisticSchema,
});
export type SaveItemResponse = z.infer<typeof saveItemResponseSchema>;

export const saveAccountRequestSchema = z.object({
	task: crawlTaskSchema,
	data: accountPageDataSchema,
});
export type SaveAccountRequest = z.infer<typeof saveAccountRequestSchema>;

export const saveAccountResponseSchema = z.object({
	statistic: accountPageStatisticSchema,
});
export type SaveAccountResponse = z.infer<typeof saveAccountResponseSchema>;

export const releaseRequestSchema = z.object({
	task: crawlTaskSchema,
	reason: releaseReasonSchema,
});
export type ReleaseRequest = z.infer<typeof releaseRequestSchema>;

export const releaseResponseSchema = z.object({});
export type ReleaseResponse = z.infer<typeof releaseResponseSchema>;

export const extendLeaseRequestSchema = z.object({
	task: crawlTaskSchema,
});
export type ExtendLeaseRequest = z.infer<typeof extendLeaseRequestSchema>;

/** `extended` is false when the task has no lease any more. */
export const extendLeaseResponseSchema = z.object({
	extended: z.boolean(),
});
export type ExtendLeaseResponse = z.infer<typeof extendLeaseResponseSchema>;

export const healthResponseSchema = z.object({
	status: z.literal('ok'),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

/** What one kind of page tab gave: seen on the page, new in the DB, and new links between rows. */
const tabFlowSchema = z.object({
	total: z.number().int(),
	newRecords: z.number().int(),
	newRelations: z.number().int(),
});
export type TabFlow = z.infer<typeof tabFlowSchema>;

/** What the saved pages added to the DB since the DB service started. It measures how well the crawl fills the DB. */
export const flowStatsSchema = z.object({
	itemPages: z.object({
		saved: z.number().int(),
		accounts: tabFlowSchema,
		tags: tabFlowSchema,
		album: tabFlowSchema,
		tracks: tabFlowSchema,
	}),
	accountPages: z.object({
		saved: z.number().int(),
		collection: tabFlowSchema,
		wishlist: tabFlowSchema,
		followers: tabFlowSchema,
		following: tabFlowSchema,
	}),
});
export type FlowStats = z.infer<typeof flowStatsSchema>;

/** Counters since the DB service started. */
export const statsResponseSchema = z.object({
	startedAt: z.coerce.date(),
	claimed: z.number().int(),
	itemsSaved: z.number().int(),
	accountsSaved: z.number().int(),
	released: z.number().int(),
	newUrls: z.number().int(),
	/** How many URLs wait to be claimed. Missing when the service cannot count them. */
	queueLeft: z.object({ items: z.number().int(), accounts: z.number().int() }).optional(),
	/** What the saved pages added. Missing for a service that does not count it. */
	flow: flowStatsSchema.optional(),
});
export type StatsResponse = z.infer<typeof statsResponseSchema>;

/** The size of the DB. Counting a big DB takes seconds, so the service reuses a number for some minutes. */
export const totalsResponseSchema = z.object({
	countedAt: z.coerce.date(),
	items: z.number().int(),
	itemsProcessed: z.number().int(),
	accounts: z.number().int(),
	accountsProcessed: z.number().int(),
	/** Links between an item and an account, collection and wishlist together. */
	itemAccountRelations: z.number().int(),
	/** The part of those links that is a wishlist. */
	wishlistRelations: z.number().int(),
	followers: z.number().int(),
});
export type TotalsResponse = z.infer<typeof totalsResponseSchema>;

/** The body of every error response. Only a message string, no stack and no Error object. */
export const errorResponseSchema = z.object({
	message: z.string(),
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;
