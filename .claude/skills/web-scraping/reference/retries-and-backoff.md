# Retries and backoff

Use this file when you write retry, backoff, rate-limit or dead-letter logic, or retries between your own services.

Policy in one line: retry only transient failures, a few times, with capped jittered backoff, through the same per-egress, per-host gate, under a retry budget. Then dead-letter with a reason key. Do not stop the whole job on the first 429. Do not retry in long fixed windows.

Related files:
- Classify first: [error-classification.md](error-classification.md)
- Egress health and rotation rules: [identity-and-proxies.md](identity-and-proxies.md)
- Pacing and jitter between requests: [politeness-and-pacing.md](politeness-and-pacing.md)
- Reason keys: [observability.md](observability.md)
- Queue states: [crawl-state-and-storage.md](crawl-state-and-storage.md)

---

## What to retry

**R062 - Retry only transient failures.** On a deterministic failure, change the approach. Do not retry with new parameters.
Because: retrying permanent errors wastes requests and looks like an attack.

| Failure | Class | Action |
|---|---|---|
| Timeout, connection reset (isolated) | Transient, page-level | Retry with backoff; counts toward the attempt cap |
| Timeouts or resets in a cluster, or confirmed by a failed control request | Egress-level | Release the URL with no count; egress health rules apply |
| 429 | Transient, rate-limit | Pause that egress for that host, then retry (see below) |
| 502, 503, 504 | Transient | Retry with backoff |
| 404, 403 | Doubtful | Hold and confirm. Never retry blindly (see "404 and 403"). |
| 400, 401, 405, 410, 422 and similar | Deterministic | No retry. Fix the request, or dead-letter. |
| Parse failure on a good page | Deterministic | No retry. Fix the parser, or record the issue. |
| Block page or challenge | Block | No retry. See [identity-and-proxies.md](identity-and-proxies.md). |

Rules:
- Run the classifier first ([error-classification.md](error-classification.md)). Retry decisions use its class, not the raw status.
- "Change the approach" means: fix headers or parameters from evidence, use another access path, or stop. It does not mean a random variant.
- Split timeouts and resets by spread. An isolated one, on an egress that serves other URLs fine, is about this URL: retry it, count it toward the attempt cap, then dead-letter. Clustered ones, or ones a failed control request confirms, are about the egress: release the URL with no count (see [error-classification.md](error-classification.md), "Three failure classes"). Because one slow page must be able to dead-letter, while a dying proxy must not burn the queue.
- Do not stop the whole job on a single 429. Pause that egress for that host and carry on.

Done when: a table-driven test shows each failure type maps to retry, hold or no retry.

---

## Backoff shape and caps

**R063 - Use exponential backoff with jitter, a cap per wait, and a cap on attempts.**
Because: unbounded or lockstep retries pile up and synchronize into a storm.

Shape (language-neutral):

```
wait = min(max_wait, base * 2^attempt)
wait = random between 0 and wait        # full jitter
(or: wait = wait/2 + random(0, wait/2))
attempts stop at max_attempts
```

Generic starting points, then tune from observed error rates: a base of a second or two, a max wait of a minute or two, three to five attempts. Per-site values differ.

Rules:
- Always add jitter. Workers that fail together must not retry together.
- Cap every single wait, and cap the attempts. A retry loop with no cap is a bug.
- Measure the wait from the end of the failed request (same rule as normal delay, see [politeness-and-pacing.md](politeness-and-pacing.md)).
- Make the wait abortable by the stop signal.
- Log attempt number and wait for every retry (see [observability.md](observability.md)).
- Reset the backoff only after a real success. A burst of 429s counts once (see "Rate-limit gate per egress and host").

Done when: a test with injected clock and randomness shows waits growing, capped, jittered, and ending at the attempt cap.

---

## Retry-After

**R064 - Honor Retry-After in both forms.** The value is either a number of seconds or an HTTP date. Parse both. Add jitter on top.
Because: the server tells you how long it needs, and guessing less causes more 429s.

Rules:
- Number: wait that many seconds. Date: wait until that time, using a clock you trust. A date in the past means a short minimum wait, not zero.
- Use the larger of Retry-After and your own backoff.
- Cap absurd values (hours or days) at a configured maximum. Then dead-letter or defer the work, and report it.
- A bad or missing value falls back to normal backoff.

Done when: tests cover seconds, date, past date, garbage, huge value and missing header.

---

## Rate-limit gate per egress and host

**R065 - A 429 pauses every worker that uses that egress for that host.** A burst of 429s during a pause counts once. Do not update the URL.
Because: parallel 429s otherwise stack backoff, and rate limits would slowly mark the whole queue as failed.

Rules:
- Keep one gate per egress and host, the same gate that does pacing ([politeness-and-pacing.md](politeness-and-pacing.md)). All workers and all retries pass through it (see R068 and [identity-and-proxies.md](identity-and-proxies.md), R040).
- A 429 from one host leaves that egress free to fetch other hosts, because a rate limit is the host's budget, not a fault of the egress. Egress-wide pauses come from egress health failures (network errors, failed control checks; see [identity-and-proxies.md](identity-and-proxies.md), R041).
- On 429: set the gate's pause-until time to the larger of Retry-After and the current backoff. Workers wait on the gate before they send.
- Re-check the pause state right before sending, not only when the wait starts.
- While paused, further 429s from requests already in flight extend nothing. They count once.
- Raise the backoff step only on the first 429 of a pause. Reset it after a real success that came after the pause ended.
- Release the URL unmarked. Leave its failure count and processed time as they were (see [error-classification.md](error-classification.md), R051).
- After a pause, lower the rate for that host. Raise it again only while 429s stay at zero.

Done when: a test with ten parallel 429s yields one pause and one backoff step, and every URL stays unmarked.

---

## 404 and 403

**R066 - Never blindly retry 404 or 403.** Hold and confirm them first.
Because: they will not change on retry, or they signal a block that more retries make deeper.

Rules:
- 404: do not retry at once. Hold it with its egress. Commit "not found" only after the egress is shown healthy (see [error-classification.md](error-classification.md), R052, R053).
- 403: never retry on the same egress. Confirm egress health with a control request.
  - Healthy: the 403 is a policy answer. Dead-letter it. No retry. Re-check robots and terms.
  - Unhealthy: it is an egress problem. Pause that egress. Release the URL with no count.
- Do not escape a 403 by switching egress to the same URL. That is rotation to evade (see [identity-and-proxies.md](identity-and-proxies.md), R039).

Done when: no code path retries 404 or 403 without passing through the hold-and-confirm step.

---

## Dead-letter path

**R067 - Give every job a dead-letter path.** After the attempt cap, move the job to a failed set with its reason key, keep the pipeline moving, and allow a later re-drive.
Because: one dead URL must not block the run, and failures must stay visible.

Rules:
- Store with each dead-lettered item: URL or id, class, reason key, last status or root code, attempts, first and last time, egress alias (no credentials).
- Reason keys are stable and few (see [observability.md](observability.md)). Free text goes in a truncated "latest example" field.
- Keep going. Never wait on a dead item.
- Re-drive on purpose: after a fix, after the block clears, or on a schedule. A re-drive resets the attempts and goes through the normal gate and budget.
- Count dead-lettered items per reason in the run report. A large number under one key means a systemic break, not noise.
- Egress-level failures never dead-letter a URL. They release it (R051). Isolated timeouts and resets are page-level and do count (see "What to retry").

Done when: a test that exhausts attempts leaves the item in the failed set with a reason, the run continues, and a re-drive processes it again.

---

## Retry budget

**R068 - Keep a retry budget.** Retries go through the same per-egress, per-host pacing gate. The share of retries per time window is capped, so retries cannot flood the proxy pool.
Because: retry storms multiply load exactly when a site or a proxy is failing.

Rules:
- A retry is a normal request for pacing purposes. No side door around the gate.
- Cap retries as a share of total requests per window (a generic start: a small fraction such as one in ten, tuned from observed load). When the budget is spent, defer or dead-letter instead of retrying.
- Count the budget per egress and per host.
- When failures rise, the budget makes the crawler slower, not louder. Pair this with the pause ladder in [identity-and-proxies.md](identity-and-proxies.md), R041.
- Do not spin through the whole queue at once to "retry everything later". Re-drive in small, paced batches.

Done when: a test with all requests failing shows retry traffic held under the cap and still passing the gate.

---

## Internal service retries

**R069 - Calls from workers to your own services retry only connection errors and explicit "busy" answers.** Use capped, jittered backoff. The service sheds load with a "busy" answer plus Retry-After.
Because: a restart or a slow query otherwise crashes or stampedes all workers at once.

Rules:
- Retry: connection refused or reset, and "busy" or "unavailable" answers. Do not retry validation errors or logic errors.
- Use the same backoff shape as R063, with shorter base values since this is your own system. Cap waits and attempts.
- On the service side: when overloaded, answer "busy" quickly with Retry-After, instead of queueing without limit.
- Workers honor that Retry-After (R064) with jitter, so they do not return in lockstep.
- Keep these retries separate from target retries. They use no scraping egress and no target budget (see [identity-and-proxies.md](identity-and-proxies.md), R046).
- After the cap, the worker releases its work unmarked and waits. It does not exit and does not mark URLs failed.

Done when: a test that restarts the service mid-run shows workers backing off with jitter, then resuming with no URL marked failed.
