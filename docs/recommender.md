# Recommender design

A recommender of Bandcamp music ("music gems") and accounts, built on the data that the crawler
stores in `band_db.sqlite`.

Status: design. Nothing here is implemented yet.

## Requirements

1. Input: the URL of the user's own account (`me`) and a seed. The seed is an account or an item.
   - Seed is an account: do not return items that `me` bought or has in the wishlist, and items
     that the seed account bought.
   - Seed is an item: do not return items that `me` bought or has in the wishlist.
2. One request takes at most 10 seconds.
3. The newest 50 items of an account weigh more than the 50 before them, and so on.
4. A wishlist item weighs much less than a bought item.
5. Focus on music gems: items that are not widely known, for example up to 100 buyers.
6. The request reads precomputed data. It does not run big joins of `items`, `accounts` and
   `items-to-accounts`.

## Current schema and data

Checked on the real DB in read-only mode (November 2026).

| Table | Rows | Notes |
|---|---|---|
| `accounts` | 3.1 M | `url`; 2.54 M processed |
| `items` | 25.6 M | tracks and albums together (`albumId` on tracks), `url`, `releaseDate` |
| `items-to-accounts` | 304 M | `itemId, accountId, wishlist`; primary key `(itemId, accountId)` |
| `items-to-tags` / `tags` / `super-tags` | 80 M / 690 K / 5.7 K | useful later for cold start and diversity |
| `followers` | 7.9 M | fan graph, useful for account recommendations |

Links per item (only items with at least one link, about 12 M):

| Links | Items | Links total |
|---|---|---|
| 1 | 3.90 M | 3.9 M |
| 2-5 | 3.61 M | 10.8 M |
| 6-20 | 2.39 M | 25.9 M |
| 21-100 | 1.53 M | 68.9 M |
| 101-500 | 491 K | 100.0 M |
| 501-2000 | 73 K | 62.9 M |
| 2000+ | 8.7 K | 31.6 M (max 36,769) |

Links per account:

| Links | Accounts | Links total |
|---|---|---|
| 1 | 165 K | 0.2 M |
| 2-10 | 817 K | 4.7 M |
| 11-50 | 947 K | 23.2 M |
| 51-200 | 513 K | 52.4 M |
| 201-1000 | 262 K | 111.5 M |
| 1001-5000 | 52 K | 98.5 M |
| 5000+ | 2.1 K | 13.6 M (max 22,365) |

Wishlist links are 32% of all links. About 13.5 M items (mostly tracks) have no links.

### Blockers

1. **No index by `accountId`.** The primary key of `items-to-accounts` starts with `itemId`, so
   "all items of an account" scans all 300 M rows. A full `GROUP BY accountId` took 169 s.
2. **No date or order of a purchase.** Requirement 3 cannot be met now. `rowid` is not a safe
   replacement: the API returns a tab from newest to oldest, but a later scan appends newer items
   at the end, and links from item supporter pages get a `rowid` before the account is scanned.

### Decision: purchase date

Add a nullable column `addedAt INTEGER` (unix seconds) to `items-to-accounts`.

- Source. Fan API records carry `added`, `updated`, `purchased` and `token`; the token starts with
  a unix time. This is confirmed by other open-source clients, not yet by our own request. Check
  the exact date format and whether wishlist records have `purchased` with one request to a
  public fan page.
- Collection: `purchased`, or `added` if it is missing. Wishlist: `added`. If both are missing,
  use the time from the token.
- Only account scans write `addedAt`. Links from item supporter pages stay NULL.
- Never overwrite a known date with NULL. When a wishlist link becomes a purchase, write the new
  date.
- `ALTER TABLE ADD COLUMN` does not rewrite the table. Old rows grow only when they are updated.

Rejected options:

- `position` (0 = newest): it shifts on every new purchase, so a rescan rewrites the whole account,
  and it cannot give a global time split.
- A per-account sequence number: stable, but it has no real time.
- A separate events table: about twice the size of the link data. It is the natural layout for
  ClickHouse (`ORDER BY (accountId, ts)`), so reconsider it when moving there.

A date gives the position at read time: sort the account's rows by `addedAt DESC`.

### Decision: index

Update: schema v2 (`db-schema-migration.md`) replaces this index. `items_to_accounts` is a
`WITHOUT ROWID` table with the primary key `(accountId, itemId)`, which serves the reads by
account, plus the index `(itemId, accountId, wishlist)` for the reads by item. v2 also adds
`addedAt`. The text below is the analysis for the old schema.

Keep one permanent covering index:

```sql
CREATE INDEX "IDX_items_to_accounts_account"
  ON "items-to-accounts" (accountId, itemId, wishlist, addedAt);
```

- Column order. `itemId` second lets the `addItems` probe (`accountId = ? AND itemId IN (...)`)
  use the index too. The recommender reads all rows of an account from the index alone and sorts
  them by `addedAt` in code; the largest account has about 22 K rows.
- Size: about 6-7 GB. The table is a rowid table, so each insert already writes two B-trees (table
  5.3 GB, primary key 5.9 GB); the index adds a third.
- Write cost (estimate, not measured): +10-20% page writes, about +0.9 GB/h to the WAL. Account
  saves barely change, because one account's rows land in one key range. Saves from item supporter
  pages pay the most, because each link lands on a random leaf, but they are about 10 times fewer.
- Risks: the index stops fitting in the OS page cache (many crawler processes compete for RAM), or
  the crawl moves to mostly supporter pages.
- Build it once, after adding `addedAt`, with the DB service stopped (the build holds the write
  lock for 5-20 minutes). Then run `PRAGMA wal_checkpoint(TRUNCATE)`. Optionally raise
  `cache_size` to 2-4 GB.
- Do not drop and rebuild indexes per workload. Each cycle writes about 12 GB, stops the crawlers,
  and the dropped pages do not shrink the file. The saving is only 10-20% of writes, and the
  recommender could not run while crawling.
- Later, in a schema migration: a `WITHOUT ROWID` table with primary key `(accountId, itemId)` and
  an index `(itemId, accountId)`. It is about 5 GB smaller than today's table plus this index.

Portability: two access paths, one by item and one by account.

- Postgres: a B-tree on `(account_id, item_id) INCLUDE (wishlist, added_at)`, built with
  `CREATE INDEX CONCURRENTLY`.
- ClickHouse: `ORDER BY (accountId, itemId)` with a projection ordered by `itemId`, and
  ReplacingMergeTree for updates of `wishlist` and `addedAt`.

### Crawler changes for `addedAt`

1. Reader (`packages/core/src/account/clients/account-page-common.ts`): add `added`, `purchased`
   and `token` to `FanRecord`. `readEmbeddedUrls` and `fetchRemainingUrls` return
   `{ url, addedAt }` instead of strings. The dedupe by URL keeps the first record.
2. Tab data and contract: an optional `addedAt` array next to `urls` in `AccountTabData` and in
   `packages/contracts/src/page-data.ts`, so older crawlers still work. Map it in
   `packages/crawler/src/mapping.ts` and `packages/db-service/src/mapping.ts`.
3. Storage: the column in `item-to-account-entity.ts`, and a migration in `SCHEMA_ADDITIONS`
   (`packages/storage-sqlite/src/db.ts`) that checks `pragma table_info` first, because
   `ADD COLUMN` has no `IF NOT EXISTS`.
4. `addItems` (`packages/storage-sqlite/src/repositories/account-repository.ts`): today new rows
   use `INSERT OR IGNORE`, so a rescan never fills the date of an existing row. Switch to
   `INSERT ... ON CONFLICT (itemId, accountId) DO UPDATE` that sets `wishlist`, takes the new date
   when `wishlist` changes, and otherwise keeps `COALESCE(addedAt, excluded.addedAt)`.
5. `addSupporters` and `addItem` never write `addedAt`.
6. Backfill. A normal rescan stops at the scan mark, so it dates only new records. Add a mode that
   ignores the mark and only fills rows where `addedAt IS NULL`. Queue accounts by priority:
   accounts with 20-1000 links first, single-link accounts last.
   - The API page limit (200 pages, about 4,000 records per tab) leaves the oldest records of big
     accounts without a date. Treat them as the oldest.
   - Rough cost: one GET per account plus one API call per about 20 links, about 15 M requests,
     about 3.5 days at 50 requests per second. Measure the share of supporter-only links first.

## Approach: item-kNN on precomputed neighbors

Joins at request time do not scale: a popular item has up to 37 K buyers, and 54 K accounts have
more than 1000 items, so the number of pairs explodes. Exact co-occurrence offline is also tens of
billions of pairs. So similarity comes from embeddings, computed offline.

### Offline job (nightly or weekly)

1. Export links from SQLite (for example with DuckDB to Parquet).
2. Weight each link:
   - purchase 1.0, wishlist 0.2-0.3 (requirement 4);
   - rank the account's links by `addedAt DESC` (NULL last) and multiply by
     `0.5 ^ floor(rank / 50)` (requirement 3).
3. Train implicit ALS (Python library `implicit`, about 64 factors) on items with at least 2 links.
   Expected memory 5-8 GB; work is linear in the number of links.
4. For every item, find the top 100 similar items with an ANN index (faiss or hnswlib) and save
   them in `item-similar(itemId PRIMARY KEY, ids BLOB, scores BLOB)`. This is the precomputed
   column of requirement 6. About 2 GB; the 18 GB `items` table is not rewritten.
5. Save `item-stats(itemId PRIMARY KEY, buyers, wishers)` for the gem filter (requirement 5).

### Request `recommend(me, seed)`

1. Read the history of `me` with the new index. Its purchases and wishlist make the exclusion set E.
2. Build the seed profile:
   - seed is an item: `{ seed: 1 }`;
   - seed is an account: its history with link weights (purchase or wishlist, freshness);
     add its purchases to E (requirement 1.1).
3. For at most 300 heaviest profile items, read their `item-similar` row and add scores:
   `score[n] += weight[p] * sim(p, n)`.
4. Filter the candidates:
   - not in E and not the seed;
   - `3 <= buyers <= 100`. The lower bound drops noise: with 1-2 buyers the similarity is random;
   - at most 2 items per artist (the subdomain of the URL).
5. Return the top k.

This is a few hundred point reads, well under one second (requirement 2). It runs in the DB
service as code, not as one SQL statement.

Note on gems: `buyers` counts only crawled accounts, not real Bandcamp sales. It works as a
relative measure, but check the threshold of 100 on real examples.

### Account recommendations

ALS also gives account vectors. Compute the top 50 similar accounts per account the same way and
store them in a separate table. `followers` can be an extra signal.

## Evaluation

- Split by time: hold out the newest purchases of each user by `addedAt`. Leave accounts with no
  dates out of the test set.
- Baselines:
  - "popular gems": the most bought items among items with at most 100 buyers;
  - the same kNN without the gem filter.
- Metrics: recall@20, NDCG@20, coverage, average popularity of recommended items. Use
  `.claude/skills/building-recommenders/scripts/evaluate_recs.py`.
- Limit the test set to gem items too. Otherwise offline metrics punish the model for its gem
  focus, because held-out items lean popular.
- Confirm the result on real users before trusting offline numbers.

## Plan

1. Schema v2 (`db-schema-migration.md`): the access path by account and the column `addedAt`.
   Then the crawler changes and backfill (see "Crawler changes for `addedAt`"), and the tables
   `item-stats` and `item-similar`.
2. Offline job that reads the DB and writes `item-stats` and `item-similar`.
3. `recommend` endpoint in the DB service.
4. Evaluation against the baselines.

## Open questions

- With a seed, should the taste of `me` affect the ranking (for example weight 0.2), or only the
  exclusions?
- Gem threshold: count purchases only, or purchases and wishlist? Is the lower bound of 3 right?
- Recommend albums only (roll tracks up to their album), or tracks too?
- Is Python fine for the offline job?
- An item in both the collection and the wishlist is saved with `wishlist = 1`, because the
  wishlist is saved after the collection. Does that matter for the weights?
