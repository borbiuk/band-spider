# DB schema migration (v2)

Status: implemented (code, migration and tests). Not yet run on the live DB.

One maintenance window that rebuilds `band_db.sqlite` into a new file with a cleaner schema. The
old file stays untouched and is the rollback.

## Goals

1. Table names in `snake_case`, so SQL does not need quotes.
2. Link tables stored once (`WITHOUT ROWID`) instead of twice (table + primary key index).
3. What the recommender needs (see `recommender.md`): links readable by account and the column
   `addedAt`.
4. Dates as integers, and the item type as a column instead of `url LIKE '%/track/%'`.

## Scope

In scope: `packages/storage-sqlite` (entities, raw SQL, counts, tests), the migration script,
`scripts/sql/*`, README and docs.

Out of scope (separate tasks):

- Filling `addedAt` from the crawler and the backfill (see `recommender.md`). The migration only
  creates the column.
- Shorter URLs (an `artists` table and `artistId`). About -1.4 GB; later, or with a move to Postgres.
- A `status` column instead of the `failedCount = 404` mark.
- Lowercasing account URLs (see "Open questions").
- Column names stay as they are (camelCase). Only table names change.

## Facts it is based on

Measured read-only on the real DB (November 2026):

| Object | GB |
|---|---|
| `items-to-accounts`: table 5.28 + primary key 5.85 | 11.13 |
| `items-to-tags`: table 1.23 + primary key 1.31 | 2.54 |
| `items`: table 2.34 + unique `url` 2.02 + `albumId` 0.31 | 4.67 |
| `account-scans` | 0.32 |
| `accounts`, `followers`, `tags` and the rest | about 0.6 |
| Whole file | 19.3 |

- SQLite in better-sqlite3 is 3.53. TypeORM is 1.1.2 and supports `@Entity({ withoutRowid: true })`.
- `varchar(N)` in SQLite is TEXT. The length is not checked and does not change the size, so the
  new schema uses `text`.
- Dates are TEXT `YYYY-MM-DD`; the time of day is lost.
- Data issues:
  - 71,116 account URLs have upper-case letters, and 47 of them have a lower-case twin. Bandcamp
    fan URLs are case-insensitive (checked by the owner), so these are 47 duplicate pairs;
  - 158 account URLs and 1 item URL have spaces around them;
  - 178 "items" are artist home pages (`https://x.bandcamp.com/`). They have 281 links, no tags,
    are no album of any track, and were never processed;
  - 5,313 more "items" are neither a track nor an album, for example
    `https://x.bandcamp.comnull`, `/subscribe` or `/vip-membership`. They have 3,844 links.
- There are no orphan rows in `followers` and `account-scans`. `foreign_keys` is ON at runtime
  (TypeORM turns it on).
- Free disk: 191 GB.

## Target schema

```sql
CREATE TABLE accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  url TEXT NOT NULL UNIQUE,
  lastProcessingDate INTEGER,              -- unix seconds
  isBusy INTEGER NOT NULL DEFAULT 0,
  failedCount INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE items (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  url TEXT NOT NULL UNIQUE,
  type INTEGER NOT NULL,                   -- 0 track, 1 album
  albumId INTEGER REFERENCES items (id),
  releaseDate INTEGER,                     -- days since 1970-01-01
  imageUrl TEXT,
  lastProcessingDate INTEGER,              -- unix seconds
  isBusy INTEGER NOT NULL DEFAULT 0,
  failedCount INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_items_album ON items (albumId);

CREATE TABLE items_to_accounts (
  accountId INTEGER NOT NULL REFERENCES accounts (id),
  itemId INTEGER NOT NULL REFERENCES items (id),
  wishlist INTEGER NOT NULL DEFAULT 0,
  addedAt INTEGER,                         -- unix seconds, filled later by the crawler
  PRIMARY KEY (accountId, itemId)
) WITHOUT ROWID;
CREATE INDEX idx_items_to_accounts_item ON items_to_accounts (itemId, accountId, wishlist);

CREATE TABLE items_to_tags (
  itemId INTEGER NOT NULL REFERENCES items (id),
  tagId INTEGER NOT NULL REFERENCES tags (id),
  PRIMARY KEY (itemId, tagId)
) WITHOUT ROWID;

CREATE TABLE followers (
  followerId INTEGER NOT NULL REFERENCES accounts (id),
  followedId INTEGER NOT NULL REFERENCES accounts (id),
  PRIMARY KEY (followerId, followedId)
) WITHOUT ROWID;

CREATE TABLE tags (id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, name TEXT NOT NULL UNIQUE);
CREATE TABLE super_tags (id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, name TEXT NOT NULL UNIQUE);
CREATE TABLE tags_to_super_tags (
  tagId INTEGER NOT NULL REFERENCES tags (id),
  superTagId INTEGER NOT NULL REFERENCES super_tags (id),
  PRIMARY KEY (tagId, superTagId)
) WITHOUT ROWID;

CREATE TABLE account_scans (
  accountId INTEGER PRIMARY KEY NOT NULL REFERENCES accounts (id),
  collection TEXT, wishlist TEXT, followers TEXT, following TEXT
);
```

The final DDL must be the one TypeORM generates from the new entities (constraint names, quoting,
column order). Generate it from the entities on an empty file and use that text in the script.
Otherwise a run with `DB_SYNCHRONIZE=true` sees a difference. TypeORM changes a SQLite table by
copying it, and on 300 M rows that would take hours.

Notes:

- `items_to_accounts`:
  - The primary key starts with `accountId`. It serves `addItems` (one account, many items) and
    the recommender (all items of an account).
  - The second index serves `addSupporters` (one item, many accounts). It holds `wishlist`, so that
    probe reads only the index.
- `id` values of `items`, `accounts` and `tags` are copied as they are, so every link stays valid.
- `sqlite_sequence` is copied too, so new ids continue after the old maximum.
- The duplicate UNIQUE constraints of the old link tables are not created again.

### Size (measured in the dry run)

| GB | v1 | v2 |
|---|---|---|
| items/accounts links | 11.13 (table 5.28 + primary key 5.85) | 8.9 (primary key 4.9 + index by item 4.0) |
| items/tags links | 2.54 | 1.03 |
| items | 4.67 | 4.46 |
| **whole file** | **19.3** | **15.1** |

v2 is 4.2 GB smaller and already holds both access paths. The old schema with the planned
recommender index would have been about 26 GB.

## Approach: build a new file

The script creates the empty v2 schema in `band_db.v2.sqlite`, attaches the old file read-only and
copies the data with `INSERT ... SELECT`.

- The old file is never changed. Rollback means using it again.
- The new file is compact, so no `VACUUM` is needed.
- Rows go into each `WITHOUT ROWID` table sorted by its primary key, so the B-tree is written in
  order. Secondary indexes are created after the data, which is faster than updating them row by row.

Rejected: `ALTER TABLE ... RENAME` in place and then `VACUUM`. The rename alone is fast and safe,
but `WITHOUT ROWID` cannot be switched on in place. The tables would be copied anyway, and in place
there is no clean rollback.

### Implementation

`packages/storage-sqlite/src/migrations/v2.ts` (`migrateToV2`, `checkV2`) and the CLI `v2-cli.ts`:

```shell
npm run db:migrate:v2 -- band_db.sqlite band_db.v2.sqlite
```

1. `BandDatabase.open` with a schema sync creates the new file. So the schema is exactly the one
   TypeORM makes from the entities.
2. The two secondary indexes are dropped and built again after the data.
3. The old file is attached as `old`. better-sqlite3 has no URI file names, so it cannot be
   attached with `mode=ro`, but the steps only read from it.
4. Each step is one SQL script in its own transaction. The new file runs with `journal_mode = OFF`,
   `synchronous = OFF`, `foreign_keys = OFF`, a 4 GB cache, `temp_store = FILE` and `threads = 4`.
   Its steps, in order:
   - the merge and drop lists (temp tables `account_merge`, `item_drop`, `item_merge`);
   - `accounts`, `items`;
   - tags and super tags;
   - `items_to_accounts`, `items_to_tags`, `followers` (each ordered by its primary key);
   - `account_scans`;
   - `sqlite_sequence`;
   - the indexes;
   - `ANALYZE`.
5. The file is switched to WAL. Then `PRAGMA integrity_check` and `PRAGMA foreign_key_check` run,
   unless `--skip-checks` is given.
6. On an error the new file is deleted. The CLI refuses an existing new file, and an old file
   without the old schema.

New code refuses to open a file with the old schema, also with `DB_SYNCHRONIZE=true`, before a
sync can touch it (`assertNotV1Schema` in `db.ts`).

## Data cleanup inside the migration

- Accounts: the new URL is `lower(trim(url))`. Rows with the same new URL are merged (the 47
  pairs):
  - keep the lower `id`;
  - move links, followers and scans to it with `INSERT OR IGNORE`, so a pair that already exists
    is not doubled;
  - keep the latest `lastProcessingDate` and the lowest `failedCount`;
  - the scan marks of the kept row win; the other row's marks are used only when the kept row has
    no scan row at all.
- `isBusy` is reset to 0 everywhere: the service is stopped, so nothing is being worked on.
- Items: the new URL is `trim(url)`. Item URLs are not lower-cased, because the case rule for
  them is not checked.
- The 178 artist home pages are not copied. Their 281 links are dropped with them.
- The other 5,313 non-track, non-album URLs are not copied either. Their 3,844 links are dropped
  with them.

From now on the storage layer normalizes URLs on every write and every lookup by URL (see "Code
changes"), so the same duplicates do not appear again. The scan marks in `account_scans` stay as
the reader gave them, because the reader compares them with what it reads.

## Code changes (`packages/storage-sqlite` unless noted)

1. Entities:
   - table names in `snake_case`, `type: 'text'` instead of `length`;
   - `withoutRowid: true` on the four link entities;
   - in `ItemToAccountEntity`, `accountId` is declared before `itemId`, because TypeORM orders the
     primary key by declaration order;
   - `@Index` for `(itemId, accountId, wishlist)`;
   - new columns `addedAt` and `items.type`;
   - date columns `integer` with transformers: `Date <-> unix seconds` for `lastProcessingDate`,
     `Date <-> days since 1970-01-01` for `releaseDate`.
2. Raw SQL with old table names: `repositories/account-repository.ts`,
   `repositories/tag-repository.ts`, `counting/count-queries.ts`, and `SCHEMA_ADDITIONS` in
   `db.ts`. `account_scans` is now part of the schema, so drop that addition.
3. Queue:
   - `notProcessedWhere` in `repositories/selection.ts`: compare integer dates;
   - `item-repository.ts`: `type = 0` instead of `ILike('%/track/%')`;
   - `NOT_PROCESSED` in `counting/count-queries.ts`: the same two changes.
4. URLs, in one place of the storage layer:
   - `insertManyByUrl` / `insertUnique` set `type` for new items, from one helper that reads it
     from the URL;
   - a URL that is neither a track nor an album is not saved as an item;
   - account URLs are trimmed and lower-cased, item URLs are trimmed. This holds for every insert
     and every lookup by URL. The returned ids still line up with the URLs the caller passed.
     The scan marks are not normalized.
5. Tests:
   - `db.test.ts` and `account-marks.test.ts` use the new names;
   - a new test checks that the migration's schema equals the schema TypeORM syncs on an empty file;
   - a small migration test: build an old-schema fixture DB, run `migrate.sql`, compare row counts
     and a few links.
6. `scripts/sql/*.sql`, `README.md`, `docs/recommender.md`: new table names.

The code ships in the same release as the migration. Old code cannot open a v2 file, and new code
cannot open an old one.

## Steps

1. **Code.** Do the changes above on a branch. All tests pass. Generate the DDL from the entities.
2. **Dry run on a copy** (no downtime). Copy the DB while the service is stopped, or use
   `sqlite3 band_db.sqlite ".backup copy.sqlite"`. Run the script on the copy and record:
   - the time of each step;
   - the size of the result;
   - the peak temp disk use;
   - the result of the checks below.

   Fix the script and repeat until it is clean.
3. **Window:**
   1. Stop the crawlers and the DB service. Run `PRAGMA wal_checkpoint(TRUNCATE)` on the old file.
   2. Run the script into `band_db.v2.sqlite`.
   3. Run the checks.
   4. Rename the old file to `band_db.v1.sqlite` and the new one to `band_db.sqlite`.
   5. Deploy the new code with `DB_SYNCHRONIZE` off. Start the DB service, then a few crawlers.
      Watch the admin and the logs, then start the rest.
4. **Keep** `band_db.v1.sqlite` for at least a week.

### Checks before switching

- `PRAGMA integrity_check` and `PRAGMA foreign_key_check` return nothing.
- Row counts match the old file, minus the 47 merged accounts, the dropped non-item URLs and their
  links (the expected numbers come from the dry run).
- No account URL differs from `lower(trim(url))`, and no item URL differs from `trim(url)`.
- `EXPLAIN QUERY PLAN` uses the primary key for the `addItems` probe, `idx_items_to_accounts_item`
  for the `addSupporters` probe, and the primary key for "all items of an account".
- The schema equals the schema that TypeORM syncs from the entities.
- The queue counts in the admin match the old counts.

### Rollback

Stop the service, put `band_db.v1.sqlite` back as `band_db.sqlite`, and deploy the previous code.
Crawl data written after the switch is lost. That is acceptable, because it is crawled again.

## Dry run (November 7, 2026)

The dry run ran on a copy of the live DB (19.3 GB; the services were stopped).

| Step | Time |
|---|---|
| merge lists | 30 s |
| accounts | 9 s |
| items | 80 s |
| tags | 1 s |
| items_to_accounts | 167 s |
| items_to_tags | 26 s |
| followers, account_scans | 11 s |
| indexes | 99 s |
| ANALYZE | 68 s |
| **migration** | **8.3 min** |
| integrity_check | 11 min |
| foreign_key_check | 5.6 min |
| **with the checks** | **25 min** |

Result:

| Table | v1 rows | v2 rows | Why they differ |
|---|---|---|---|
| accounts | 3,103,644 | 3,103,597 | 47 merged |
| items | 25,576,120 | 25,570,628 | 5,491 non-items dropped, 1 merged |
| items_to_accounts | 304,029,712 | 304,015,757 | links of dropped items, merged duplicates |
| items_to_tags | 79,527,840 | 79,527,840 | |
| followers | 7,937,463 | 7,933,093 | merged duplicates and self-follows |
| account_scans | 2,381,258 | 2,381,243 | marks of merged accounts |

- Both checks found 0 problems.
- A TypeORM sync on the result changes nothing.
- The app code opens the file and claims tasks.
- Old and new dates match on sampled rows.
- Peak memory was 9.3 GB (the 4 GB cache plus the sorter). The machine has 64 GB.

Query plans on the result:

- all items of an account: `SEARCH items_to_accounts USING PRIMARY KEY (accountId=?)`. 0.1 ms for an
  account with 3,109 items.
- `addSupporters` probe (`itemId = ? AND accountId IN (...)`):
  `USING COVERING INDEX idx_items_to_accounts_item`.
- `addItems` probe (`accountId = ? AND itemId IN (...)`): after `ANALYZE` the planner also picks
  `idx_items_to_accounts_item` (`itemId=? AND accountId=?`). It is a point lookup per item either
  way, so it stays fast. Only the locality of the primary key is lost. Watch the save times after
  the switch.
- the item queue: a scan of `items`, as before. It stops after 400 rows, and 19.7 M items wait.

Downtime with the checks is about 25 min, plus the time to stop and start the services.

Risks:

- the sort runs out of temp space: point `SQLITE_TMPDIR` at the data disk;
- the DDL differs from the TypeORM schema: covered by the migration test;
- forgotten raw SQL with old names: a grep for the old names must find nothing outside `docs/`,
  the v1 fixture and the migration.

## Portability

- Postgres:
  - link tables: a primary key and one more B-tree index, the same two access paths;
  - dates: `timestamptz`;
  - `type`: `smallint` or an enum.
- ClickHouse:
  - `items_to_accounts` ordered by `(accountId, itemId)`, with a projection ordered by `itemId`;
  - ReplacingMergeTree for the updates of `wishlist` and `addedAt`.
- `snake_case` table names work everywhere without quotes.

## Open questions

- Where does `...comnull` come from? It looks like a bug in the code that builds item URLs. Fix
  it separately.

## Decisions

- Bandcamp fan URLs are case-insensitive: the 47 duplicate pairs are merged, and account URLs are
  stored in lower case.
- The 178 artist home pages are deleted.
- The other 5,313 non-track, non-album URLs (`...comnull`, `/subscribe`, `/vip-membership` and the
  like) are deleted too.
- `releaseDate` is stored as days since 1970-01-01.
