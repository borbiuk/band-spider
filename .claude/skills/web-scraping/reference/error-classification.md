# Error classification

Use this file when you write code that decides what a response means, or when many URLs fail or turn up "not found" at once.

The central question for every response: did the page answer, or did my path fail? Get this wrong and you erase live URLs from the queue.

Related files:
- Retry and backoff after you have classified: [retries-and-backoff.md](retries-and-backoff.md)
- Egress health and pausing: [identity-and-proxies.md](identity-and-proxies.md)
- Reason keys and metrics: [observability.md](observability.md)
- Validation of parsed data: [extraction-and-data-quality.md](extraction-and-data-quality.md)
- URL states and release of work: [crawl-state-and-storage.md](crawl-state-and-storage.md)

---

## Three failure classes

**R050 - Classify every failure before you act.** Put it in exactly one class.
Because: the right action differs completely per class, and one wrong class destroys data or hammers a site.

| Class | Meaning | Typical signs | Action |
|---|---|---|---|
| Page-level | The site answered about this URL | Confirmed not found, parse failure on a real page, confirmed policy refusal | Count against the URL. Retry or finish per rules. |
| Egress-level | Your path failed or is blocked | Resets, DNS, refused, proxy auth error, timeouts in a cluster, block pages, 404 or 403 on many URLs at once | Pause that egress. Release the URL. No URL count. A challenge page also pauses the host (see "Content over status"). |
| Rate-limit | The site asked you to slow down | 429, Retry-After, throttling pages | Pause that egress for that host, back off. No URL count. See [retries-and-backoff.md](retries-and-backoff.md). |

An isolated timeout or reset on an egress that serves other URLs fine is page-level; the split is in [retries-and-backoff.md](retries-and-backoff.md), "What to retry".

Rules:
- Classify in one function, in one place. Every code path uses it.
- When unsure, the answer is "doubtful". Hold it (see "Held answers") and do not guess.
- Record the class and a reason key with every failure.

Done when: every failure path returns a class and a reason, and no code path updates a URL after an unclassified error.

---

## What counts against a URL

**R051 - Only page-level errors raise a URL's failure count.** Egress-level and rate-limit errors release the URL with no count.
Because: a short proxy outage would otherwise push many live URLs over the failure limit for good.

Rules:
- Release means: return the URL to the queue, unmarked, with its fail count and processed time unchanged.
- Count only after the class is page-level and the egress is shown healthy.
- Keep the failure limit for page-level errors only.

**R061 - A missing optional element is not a scrape error.** Count a parse failure only when a required part of a real page cannot be read.
Because: whole valid page classes (for example items with no image) would otherwise hit the failure limit and be dropped.
Do: mark optional fields as null with a recorded note (see [extraction-and-data-quality.md](extraction-and-data-quality.md)). Fail the URL only when required fields or the page structure are missing.

Done when: a simulated proxy outage leaves all URL counts unchanged, and a page without optional fields saves successfully.

---

## Held answers and control requests

**R052 - Never write "not found" straight to storage.** Hold each 404 together with the egress that received it. Commit it only after that egress is shown healthy around that moment.
Because: a blocked IP or broken proxy often answers 404 for every URL, and committing them erases the queue.

Holding rules:
- Keep each held answer in memory or in a held state: URL, answer, egress, time.
- A held URL is not done, not failed and not retried yet.
- Do not retry a held 404 straight away on the same egress.
- On shutdown, release held URLs unmarked (see [crawl-state-and-storage.md](crawl-state-and-storage.md)).

**R053 - Confirm doubtful answers with a control request.** Request a known-good URL on the same host through the same egress: a page that you know exists and that returned a good result before.
Because: only a reference request on the same path separates "page gone" from "my path is broken", and a control on another host cannot see a block that one host put on this egress.

| Control result | Do |
|---|---|
| Passes (expected content) | Egress is healthy. Commit the held answers (404 becomes not found; 403 becomes a policy answer). |
| Fails (error, block page, wrong content) | Egress is the problem. Release held URLs unmarked. Flag and pause the egress. |
| Rate-limit answer | Pause and re-check later. Keep answers held. |

Rules:
- Pick control URLs from pages you fetched successfully earlier. Keep a small set per host, stable and cheap.
- Judge the control response by content (R055), not just status.
- Send the control request through the normal pacing gate. It is also a request.
- A 403 follows the same path. Never retry a 403 on the same egress (see [retries-and-backoff.md](retries-and-backoff.md)).
- Good pages shortly before and after the held answer are also valid evidence of health, and can replace a control request.

Done when: for each scenario (404 on healthy egress, 404 on broken egress, control rate-limited) the held URLs end in the expected state, with a release reason recorded.

---

## Control-check triggers

**R054 - Trigger control checks by count, by share per error kind, and by maximum hold time.** Reset the counts after each check.
Because: one fixed threshold misfires on normal 404 rates or misses a broken proxy.

| Error kind | Trigger style |
|---|---|
| 404 (held) | Loose: a larger count or share, since real 404s are normal on some sites |
| 403 | Medium: confirm early, because it may signal a block |
| Network errors (reset, refused, DNS, proxy auth) | Strict: a few in a short window or a short streak |
| Max hold time | Always: check when the oldest held answer reaches a time limit, even if counts are low |

Start values are generic starting points: pick a count and a share per kind, then tune from your observed 404 rate and error rate. Keep the values as named constants in one place.

Done when: a low trickle of 404s still triggers a check by time, and a burst of resets triggers one fast.

---

## Content over status

**R055 - Judge the content, not the status.** Block pages often arrive with status 200.
Because: status codes are easy to fake and easy to misread, and the body tells you what happened.

| Observation | Meaning | Class |
|---|---|---|
| 200 with a CAPTCHA or challenge | Bot-detection block | Egress-level for counting (no URL count), and it pauses the host on every egress (see below) |
| 200 with "access denied" or an empty body | Block or failure | Egress-level (suspect), not content |
| 200 with a known not-found template | Soft 404 | Page-level not found, but hold it (R052) |
| 200 missing the expected structure (no required container) | Egress suspect, not a 404 | Hold and run a control check |
| 200 with expected structure | Success | Parse it |
| 404 with a normal site layout | Possible real not found | Hold (R052) |

Rules:
- Build content checks per target: a marker you expect on every good page, markers of known block pages, and the not-found template.
- Check body size and required markers before parsing.
- Never save a block page as page data.
- Keep a raw sample of each new kind of unexpected page for review.
- On a challenge page, run the bot-detection remedy for the whole host ("Remedy by block type" and [identity-and-proxies.md](identity-and-proxies.md), "Challenges and honeypots"), not only an egress pause, because a challenge is the host's answer to your client and re-sending its URLs through another egress is rotation to escape.

**R059 - Confirm a restriction before assuming an auth wall.** Soft 404s, auth walls and rate limits look alike. Compare with a known-good URL on the same host through the same egress, and with the same URL after a pause, before you declare the content restricted or ask the user to log in.
Because: asking for login or marking content restricted on a wrong guess wastes the user's time and hides real data.

Done when: every success path checks structure, every known block template maps to a class, and "needs login" is reported only after the control comparison.

---

## Terminal not-found state

**R056 - Store "not found" as its own terminal state.** Later failures must not overwrite it.
Because: mixed states break retry logic and statistics: a not-found URL would be retried as a failure, or a failure would hide a true not found.

Rules:
- State set: pending, claimed, done, not found, failed (see [crawl-state-and-storage.md](crawl-state-and-storage.md)).
- Enter "not found" only through a confirmed path (R052, R053).
- A terminal state changes only by an explicit re-check job, never by a retry.
- Report not-found counts apart from failures.

Done when: a test that sends a network error to a not-found URL leaves it not found.

---

## Partial records

**R057 - If any sub-request of a record is refused, fail the whole record.** Never save a partial list as complete.
Because: truncated data saved as complete is never read again, and the loss stays silent.

Applies to: paginated lists, detail pages made of several calls, records that join several endpoints.

Do:
- Treat a refusal, a block page or a rate limit in any sub-request as a failure of the record. Release it by class (egress-level releases without a count).
- Write the record in one step only after all parts are read.
- When a hard cap ends a read early, mark the record incomplete (see [extraction-and-data-quality.md](extraction-and-data-quality.md)).

Done when: a test that refuses page 3 of 5 leaves the record unsaved and the URL released.

---

## Root-cause error codes

**R058 - Unwrap generic network errors to their root cause code before you log or count them.**
Because: a message like "fetch failed" hides DNS failure, reset, refused connection and proxy auth failure, which need different actions.

Rules:
- Walk the error's cause chain to the innermost error and take its code.
- Map codes to classes: DNS, reset, refused, timeout, proxy auth, TLS, unknown. Most are egress-level.
- Use the code as the reason key (see [observability.md](observability.md)). Keep keys few and stable.
- Redact credentials in the message before logging (see [identity-and-proxies.md](identity-and-proxies.md), "Secrets and profiles").

Done when: a log never shows a bare generic message without a root code.

---

## Remedy by block type

**R060 - Match the remedy to the block type.**
Because: fixing the wrong cause makes the block worse.

| Block type | Evidence | Remedy |
|---|---|---|
| Rate limit | 429, Retry-After, errors that fade after a pause | Slow down, pause the egress, honor Retry-After |
| IP block | Many URLs fail at once on one egress, control request fails, other egress works | Pause that egress, release URLs, repair or replace it |
| Bot detection | Challenge pages (even one), fingerprint checks, blocks across several IPs | Pause the host on every egress, stop and reassess. Keep its released URLs off other egresses. See [identity-and-proxies.md](identity-and-proxies.md), "Challenges and honeypots". |
| Policy refusal | 403 or similar confirmed on a healthy egress | Dead-letter. Do not retry. Re-check robots and terms. |
| Real not found | Confirmed by healthy egress | Terminal not-found |

Done when: each class of block in the table has one coded action, and none of them is "retry with a new IP".
