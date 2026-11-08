# Testing scrapers offline

Use this file when you write or fix scraper tests, refactor scraper code, or capture fixtures.

The suite runs fully offline. Recorded fixtures stand in for the site. Any live check is monitoring, not a test (last section).

## Fixtures and local server

Serve recorded responses from a local server. Point the scraper at it. (R114)

- Record status, headers and body for each fixture, not just the body. Because the scraper reads all three.
- Bind the server to loopback only. Use a throwaway storage location per test run.
- Never let a test reach the real site or real production storage. Because network tests are flaky, and they put load on the target.
- Fail the test run if any request leaves loopback. Block outbound network in the test setup.
- Keep one fixture set per page type: list page, detail page, empty result, last page, layout variant.

Done when: the whole suite passes with the network disabled, and no test path names a real host or a real data store.

## Failure-shape fixtures

Add a fixture for every failure shape the scraper must classify. Because error paths are where scrapers break in production. (R115)

Minimum set:

| Shape | What it proves |
|---|---|
| Not-found page (404) | Held and confirmed, not committed at once |
| 200 response with a block page, challenge or empty body | Content is judged, not status |
| 429 with Retry-After (seconds form) | Wait honors the header |
| 429 with Retry-After (date form) | Date form parses |
| 429 without Retry-After | Backoff uses its own schedule |
| 403 | Never retried on the same egress; control request decides |
| 5xx transient (502, 503, 504) | Retried within the cap |
| Refused sub-request in a multi-request record | Whole record fails, no partial save |
| Network errors: timeout, reset, refused, DNS failure | Counted as egress-level, root cause named |
| Page with a missing optional element | Not an error |

Each fixture carries its expected outcome. The test asserts the outcome and the reason key.

How each shape must be handled lives in [error-classification.md](error-classification.md) and [retries-and-backoff.md](retries-and-backoff.md). Do not restate it here.

Done when: every row in the table has a fixture and an asserted outcome.

## Injecting time and randomness

Pass the clock, the sleep function, the random source and the fetch function into every timing component. (R116)

Because timing logic that reads real time or real randomness is untestable or flaky.

- Clock: a fake that you advance by hand.
- Sleep: a fake that records the requested wait and returns at once.
- Random: a seeded source, so jitter is repeatable.
- Fetch: a fake transport that returns scripted responses in order.

Pseudocode:

```
pacer = Pacer(clock=fake_clock, sleep=fake_sleep, rand=seeded(1))
pacer.wait_turn(egress="a")
assert fake_sleep.calls[-1] within [base, base + jitter_max]
```

What to assert:

- Waits fall inside the expected jitter range, never at one fixed value.
- Delay is measured from the end of the previous request, failed ones included.
- Backoff grows, hits its cap, and stops at the attempt cap.
- A long wait ends at once when the stop signal fires.

Done when: no timing test calls real sleep or real time, and the suite runs in a fraction of the wait time it simulates.

## End-to-end worker tests

Run the full worker loop against fake transports. Assert the release reason of every task in every scenario. (R117)

Because the classification logic is the riskiest code. A wrong release reason loses live URLs or marks them dead.

Scenarios to cover, each with its expected release reason and failure count:

1. Page found: saved, done.
2. 404 held, control request passes: committed as not-found.
3. 404 held, control request fails: released unmarked, egress flagged, no count.
4. Network error: released without a count.
5. 429: egress paused for that host only, other hosts still served, URL untouched.
6. 403 on a healthy egress: dead-lettered with a reason key.
7. Pause set while a worker waits: no request sent.
8. Halt: remaining tasks released unmarked, clean exit.

Use fake transports for both the site and the control URL, so one test can script "page fails, control passes" and the reverse.

Done when: each scenario asserts the task state, the failure count and the reason key, not only "no crash".

## Characterization and race tests

Before a big refactor, pin current behavior with characterization tests. Run them before and after. (R118)

Because refactors silently change behavior that nobody wrote down.

- Feed recorded inputs through the current code and snapshot the outputs: parsed records, states, reason keys.
- Review the snapshot once by hand. Fix real bugs in a separate change, not inside the refactor.
- Simulate write races with fakes: two writers inserting the same ID, a claim taken twice, a unique-key error on insert. Assert one record, no crash.
- Simulate a store that fails once, then works.

Done when: the snapshot passes unchanged after the refactor, and each race fake ends with exactly one record per ID.

## Test layers

Layer the suite. Run every layer on every change. (R119)

Because each layer catches a different breakage early.

| Layer | Scope | Input |
|---|---|---|
| Parser unit | One parser function on one page | Fixture |
| Smoke | Whole pipeline on a handful of pages | Local server |
| Regression | A fixture for every bug ever fixed | Fixture saved from the bug |

Add a regression fixture with each fix. The fixture is the proof the bug stays fixed.

Done when: each layer has at least one passing test, and each past bug has a fixture.

## Capturing and scrubbing fixtures

Capture fixtures from real responses. Then trim them and scrub secrets and personal data before you commit. (R120)

Because fixtures leak credentials and personal data into version control, where they stay.

Steps:

1. Fetch the page once, politely (see [politeness-and-pacing.md](politeness-and-pacing.md)). Save status, headers and body.
2. Trim: keep the parts the parser needs plus enough surrounding structure to catch layout shifts.
3. Scrub headers: cookies, authorization, tokens, session IDs, proxy credentials, IP addresses of your egress.
4. Scrub body: names, emails, phone numbers, addresses, user IDs, tokens in URLs or inline scripts. Replace with fixed fake values of the same shape.
5. Search the result for the scrubbed patterns before you commit.

Check that the parser still passes on the scrubbed copy. A scrub that changes the shape hides bugs.

Done when: a search for secret and personal-data patterns finds nothing, and the parser tests still pass on the scrubbed file.

## Setup smoke and pinned dependencies

### One tiny setup request

Before real work, send one tiny request to check setup, credentials and tooling. (R121)

Because it detects setup errors cheaply, before they repeat across a bulk run.

- One request, to one allowed URL, paced like production.
- Check: status, parsed field, credentials accepted, proxy reachable, tooling present.
- Stop on failure. Fix the setup, do not widen the run.

### Reproducible environment

Pin dependency versions. Use a lockfile. Pin the HTTP client and its transitive dependencies, and use one version of them across the project. Download browser binaries at build time, not at first run. (R122)

Because unplanned changes in the HTTP stack change behavior on edge cases, and drift breaks reproducibility.

- Commit the lockfile. Keep dependency-resolution and version-conflict checks on; fix the conflict instead of overriding the check to make an install pass.
- Run the suite from a clean install in CI.
- Upgrade the HTTP stack on purpose, in its own change, with the failure-shape fixtures green.

Done when: a fresh checkout installs from the lockfile and runs the suite with no extra steps, and the setup smoke request passes.

## Check the written procedure

Have a separate agent or person follow only the written scraping procedure. (R123)

Because the author fills gaps from memory, and only an outsider finds unclear steps.

- Give the reader the procedure text and nothing else.
- Collect every question they ask and every place they guess.
- Fix the text, then run again with a fresh reader.

Done when: a fresh reader completes the procedure with no question and no guess.

## Live checks are monitoring, not tests

Keep live checks out of the suite. A scheduled live check is monitoring: tiny, paced like production, and alerting on a site change. Because tests must be deterministic and must not load the target, while monitoring still catches layout shifts. Details on alerts: [observability.md](observability.md).

Done when: the suite passes offline, and any live check is separate, scheduled and small.
