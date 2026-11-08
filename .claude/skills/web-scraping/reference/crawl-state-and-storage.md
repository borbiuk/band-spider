# Crawl state and storage

Use this file when you design the queue, schema, IDs, dedup, crash resume, multi-worker claims, shutdown, incremental re-crawls or migrations.

Highest impact first: raw storage (R072), durable per-URL state (R074), stable IDs (R071), URL normalization (R070), leases (R075). The sections below follow build order, not rank.

## URL normalization (R070)

Normalize every URL before dedup and before storage, because two spellings of one page become two rows and pollute the queue.

Steps:
1. Trim whitespace.
2. Resolve to an absolute URL against the page it came from.
3. Drop the fragment and known tracking parameters.
4. Sort the remaining query parameters when order has no meaning on this site.
5. Lowercase the scheme and host. Change the case of the path only where you verified the site treats it as the same page, because many servers treat paths as case-sensitive.
6. Reject URLs of the wrong type at insert (other hosts, mailto, files you do not want, pages outside the include patterns). Check the type at the door because a bad URL that enters the queue costs a request later.

Keep the original URL in a separate field. Never overwrite it.

Done when: the same page reached by three different links produces one queue row, and a wrong-type URL never gets a row.

## Stable IDs and idempotent writes (R071)

Give every record a stable ID built from the source identity (a site ID, or the normalized URL). Write by upsert on that ID, because a re-run or a second writer must update the row, not add a copy.

Make inserts race-safe:
1. Look up by ID.
2. If missing, insert.
3. If the insert fails on the unique key, look up again and update.

Never let a unique-key error crash a worker. It means another writer won the race.

Done when: running the same batch twice leaves the row count unchanged, and two workers inserting the same ID produce one row and no crash.

## Raw vs parsed (R072, R073)

Store the raw response for every record you write. Keep it apart from the parsed output (compressed, with a retention limit), because then a parser bug or layout fix costs a re-parse, not a re-crawl.

- Link each parsed record to its raw copy by ID.
- Version the parser. Store the parser version on the parsed row so you know which rows need a re-parse.
- When storage is tight, shorten retention first. Keep at least one raw sample per parse-error kind (R073), because a failure you cannot reproduce cannot be fixed without fetching again.
- Scrub secrets from stored headers and bodies (see [identity-and-proxies.md](identity-and-proxies.md)).

Done when: you can re-run the parser over stored raw data with no network, and every error kind has a stored sample.

## Per-URL state and resume (R074)

Keep a durable state per URL: pending, claimed, done, not-found, failed. Store it in durable storage, not memory, because a crash must resume where it stopped.

- Write the state change in the same transaction as the result (see Atomic saves below).
- Keep not-found and failed as separate terminal states. Later failures must not overwrite them (rules in [error-classification.md](error-classification.md)).
- On start, move stale claims back to pending (see Leases).
- Store attempt count, last reason key and last-change time on the row.

Done when: you kill the process mid-run, restart it, and it finishes the rest with no URL lost and none repeated beyond the claim in flight.

## Leases (R075)

Hand out work with an expiring lease. Workers extend the lease while they are busy, because a crash must free the URL by expiry and a slow page must not lose its claim.

Rules:
1. A claim carries an owner and an expiry time.
2. A busy worker extends the expiry on a timer shorter than the lease.
3. An expired lease makes the URL claimable again.
4. Only the store owner resets claims, and only once at its own start. Workers never reset claims they do not own, because a reset while others run double-assigns work.

Choose the lease length from the slowest normal fetch plus retries. Start generous, then tune from observed claim-expiry counts.

Done when: a killed worker's URLs return to pending after expiry, and no URL is held by two live workers.

## Graceful stop and supervision (R076, R082, R083)

### Stop (R076)

On the first stop signal:
1. Finish the current unit of work.
2. Release held and unconfirmed tasks without marking them, because an unmarked URL is retried and a wrongly marked one is lost.
3. Flush metrics.
4. Exit.

A second signal exits at once. Child workers stop when their supervisor goes away, so no orphan keeps sending requests.

### Empty queue and one-shot exit (R082)

A long-running crawler idle-waits and re-polls on an empty queue. Exiting leaves a dead crawler when new work arrives. A one-shot run resolves every held answer (held 404s, pending control checks) before it exits, because an undecided answer is a URL in limbo.

### Supervision (R083)

When a supervisor process starts and stops crawler processes, follow these rules. A single-process scraper can skip them.

- Start a worker only after its dependencies report ready.
- Ask for a stop, wait a grace period, then hard-kill, because a hung stop blocks the whole system.
- Treat a non-zero exit, or a signal exit with no "finished" report, as a failure. Restart it under a bounded policy and log it.

Done when: a stop signal during a busy run leaves zero marked-wrong URLs and zero orphan processes, and a killed worker shows up as a failure in logs.

## Queue architecture and layers (R077, R084)

### Queue (R077)

Decouple fetch, parse and write with a queue, because one slow stage must not stall the others. Re-queue failures under the retry rules in [retries-and-backoff.md](retries-and-backoff.md). Scale by adding workers. Give each worker its own egress budget, or put them behind one shared pacing gate ([politeness-and-pacing.md](politeness-and-pacing.md)), because more workers on one IP raise its real rate.

### Layers (R084)

Keep three layers apart: fetch (network, status, egress), parse (HTML or JSON to fields) and store (rows, state). Keep selectors in one shared place or per-site config. Then you can tell which layer broke, and fix a selector by editing config, not code. Rules for the selectors are in [extraction-and-data-quality.md](extraction-and-data-quality.md).

Done when: you can swap the parser without touching fetch or store, and a failure report names its layer.

## Incremental re-crawl (R078)

For newest-first lists, keep a high-water mark (newest item already seen). Save the mark only after the whole read completes, because a mark saved early lets a crashed read skip items for good. Stop reading when you meet items older than the mark. If the mark is missing, do a full read, because stopping early on a guess loses data. A capped or failed read leaves the old mark in place ([extraction-and-data-quality.md](extraction-and-data-quality.md), pagination).

Done when: a second run reads only new items, and a run killed halfway leaves the old mark.

## Atomic saves and streaming (R079, R080)

- Save each scraped page in one transaction (record, children, state change), because half-saved pages and mixed transactions corrupt state (R079).
- On a single-writer store, serialize writes through one writer path or queue, because concurrent writers fail with lock errors or interleave transactions.
- On a multi-writer store, use transactions with a fitting isolation level and upsert on the unique key, because parallel writers otherwise lose updates or insert duplicates.
- Stream rows to storage in batches instead of holding all in memory, because large runs exhaust memory (R080). Flush a batch on size or time, and flush on stop.

Done when: a crash never leaves a record without its state, and memory stays flat as the run grows.

## Provenance (R081)

Store on every record: source URL, fetch time, method used (API, embedded JSON, HTML, browser), and the run inputs (parser version, config version). It makes any value traceable and any run reproducible, because without it you cannot tell which rows a bad parser touched.

Done when: from any record you can name the page, time and code version that produced it.

## Database maintenance (R085)

Before you copy or migrate the store:
1. Take a consistent copy. For a file-based store, flush or checkpoint its write log first. For a server database, use its own backup or snapshot tool. Because a copy taken mid-write misses data.
2. Build the new version beside the old one.
3. Run an integrity check on the new version.
4. Switch over.
5. Keep the old version for rollback, because a failed migration must be reversible.

Build beside the old store rather than migrating in place, so the old copy stays a clean rollback point.

Done when: the new version passes the check, and the old one is still available and untouched.
