# Observability

Use this file when you add logging, metrics, dashboards or alerts, or run a crawler longer than one session.

Highest impact first: core metrics (R104), failure-rate shape (R108), reason keys (R103), queue lag (R105).

## Failure reason keys (R103)

Give every failure a stable, low-cardinality reason key (for example timeout, reset, dns, http_403, parse_missing_field). One opaque failure number cannot be diagnosed.

- Keep a count and the latest example per key.
- Cap the number of keys. Map anything unknown to one "other" key, because unbounded keys blow up storage and dashboards.
- Truncate stored messages.
- Unwrap generic network errors to their root cause first ([error-classification.md](error-classification.md)).
- Use the same keys in dead-letter records ([retries-and-backoff.md](retries-and-backoff.md)).

Done when: every failed URL carries one key from a fixed list, and you can list the top keys with an example each.

## Core metrics (R104)

Track per host and per egress:
- Error rate by class (page, egress, rate-limit).
- Block and challenge rate.
- 429 rate.
- Latency (median and a high percentile).
- Throughput.
- Saved records.

Slow degradation looks like "still running", so a single total hides it. Per-egress numbers separate a bad proxy from a bad site.

Done when: you can answer "which host and which egress got worse in the last window" from the metrics alone.

## Queue lag (R105)

Track queue lag, not only depth: the age of the oldest pending item and the estimated time to drain. Depth alone hides a stuck or starving queue, because a small queue with a very old head is stuck.

Done when: an alert fires when the oldest pending item grows past its limit, even if depth is small.

## Counters and rates (R106)

Workers report cumulative counters. The monitor computes rates from deltas between reports. Treat a falling counter as a restart: reset the baseline, and do not compute a negative rate. Lost reports then cost one sample, not a wrong total.

Done when: killing and restarting a worker never shows a negative rate.

## Yield and cost (R107)

Measure useful yield (new records per request) and proxy bytes as billed. A fast crawler may only be re-reading known data, and bandwidth bills surprise. Count billed bytes at the proxy edge, including failed and retried requests, not only successful bodies.

Done when: the run report shows new records per request and billed bytes per new record.

## Reading failure-rate shape (R108)

Read the shape, not the number:
- Near 100% failure means a systemic break (layout change, block, dead egress).
- A low steady rate is noise. Retries handle it.
- A creeping rise in 403 or challenges is an early block warning. Slow down or stop and re-check the egress, because pushing on deepens the block (see [politeness-and-pacing.md](politeness-and-pacing.md) and [identity-and-proxies.md](identity-and-proxies.md)).

Done when: each alert names the shape (break, noise or creep) and the first action for it.

## Alerts (R109)

Send alerts to the people who fix scrapers. Keep one view of failing scrapers and missing fields over time, so repair is fast and repeat breakers are visible. Alert on shapes and drops (fill rate, failure shape, lag), not on every single error, because noisy alerts get ignored. Quality signals are defined in [extraction-and-data-quality.md](extraction-and-data-quality.md).

Done when: each alert has an owner, and the view shows per-scraper failures and field fill rates.

## Request logging (R110)

Log every request outcome: URL, status, attempt number, wait before it, reason key, egress label. Log every escalation and recovery step too (pause, control check, resume, access-method change), because a failure you cannot replay cannot be diagnosed. Log egress by label, never by credential.

Done when: from the log alone you can rebuild why one URL was retried, paused or dead-lettered.

## Keeping monitoring cheap (R111)

Keep expensive counts (queue size, totals) off the hot path. Cache them, refresh in the background, and allow only one refresh at a time, because a dashboard query that scans the store can slow or block claims and saves on stores where long reads contend with writes.

Done when: opening the dashboard does not slow claim or save latency.

## Log hygiene (R112)

- If your logger reserves field names (often level, time, msg or message), name your own fields differently, because a clash overwrites the reserved value and loses it.
- If you use a colored console formatter, keep it out of file logs, because color codes make files unreadable.
- Never log secrets: proxy passwords, tokens, cookies, auth headers. Redact before the logger sees them ([identity-and-proxies.md](identity-and-proxies.md)).

Done when: a search of the log files finds no secret and no escape sequences, and every line has a level.

## Run report (R113)

End each run or recon with the hand-back report defined in [SKILL.md](../SKILL.md), "What to hand back"; it is the one template. For a monitored run, add the run metrics to its Result and Failures parts: requests sent, new records per request, billed bytes, and queue lag at the end, because they show whether the run was healthy, not only whether it finished. Coverage wording rules are in [extraction-and-data-quality.md](extraction-and-data-quality.md).

Done when: a reader can tell what the data covers and what to check next without asking you.
