# Politeness and pacing

Use this file when you set rates, delays or concurrency, add workers, schedule runs, add caching, or see 429s, slowdowns or operator complaints.

Goal: keep the real request rate on each host and egress under the site's budget, and fetch nothing twice.

Terms: an egress is the network path your requests leave from (one IP, one proxy). A gate is the single pacing component every request must pass before it is sent.

## Pace per egress and host

- **Use one shared gate per egress and host (R022).** All workers that share an egress IP go through one gate for each target host. Never give each worker its own pacing. Because per-worker clients silently multiply the real rate on one IP.
- **One crawler per egress, or a shared gate.** Rules for proxies and egress health are in [identity-and-proxies.md](identity-and-proxies.md).
- **Send retries through the same gate.** Retry rules are in [retries-and-backoff.md](retries-and-backoff.md).

Done when: you can point to the one place that decides "may this request start now" for each egress and host, and every request path (first tries, retries, control requests) goes through it.

## Jitter and end-to-start delay

- **Add random jitter to every delay (R023).** Pick each wait from a range, never a fixed value. Because even spacing is a bot signal and makes workers hit the server in sync.
- **Measure from the end of the previous request to the start of the next (R024).** Count failed and rate-limited requests too. Because start-to-start spacing removes idle time exactly when the server is slow, which is when it needs the relief.

```
wait_until = end_time_of_last_request + base_delay + random(0, jitter)
gate: block until now >= wait_until, then start; record end_time when the request finishes or fails
```

Generic starting point: jitter of about a quarter to a half of the base delay. Tune from observed behavior.

Done when: a test with a fake clock shows the gap is measured from request end, includes failures, and varies between requests.

## Concurrency vs rate

- **Control two numbers separately (R025).** Concurrency is how many requests are in flight. Rate is how many start per second. Cap both, per host. Because mixing them either crawls slowly or hammers one host, and capacity differs by orders of magnitude between targets.
- **Start low, raise slowly.** Begin with one request in flight per host. Raise only while error rate, 429 count, and latency stay flat. Lower on any rate-limit or strain signal. Total concurrency across many hosts may be higher than any single host's.
- **Treat numbers from articles as examples only.** No universal figure exists.

Done when: each host has its own concurrency cap and rate cap, and the config shows how each was reached (default, observed, declared).

## Choosing and tuning the delay

- **Tune from observed signals (R026).** Watch rate-limit answers, blocks, and latency. Slow down when they rise. Speed up only in small steps while they stay flat. Because guessed delays are either too slow or too fast.
- **Keep one tested default constant.** Store the default delay in a single named setting. Update the docs when you change it. Because drifted constants confuse operators and make runs unreproducible.

Generic starting point: begin around one request per second per host for a small unknown site, then adjust from the observed error and latency curve. This is an example, not a rule.

Done when: the default lives in one place, a test pins it, and the docs quote the same value.

## Declared limits and strain signals

- **Honor declared limits (R027).** Read crawl-delay from robots.txt and any stated rate in API docs or terms. Obey them. When you observe a limit yourself, stay well below it. Because the site has told you its budget. Do it as politeness, not as disguise.
- **Slow down or stop on strain (R028).** Strain signs: rising latency, growing 503s, timeouts, complaints from the operator. Reduce rate at once. If the signs continue, pause the host and report. Because these mean you are hurting the site. Do not stop the whole job on a single 429; use the pause and backoff rules in [retries-and-backoff.md](retries-and-backoff.md).
- **Prefer off-peak hours for large runs (R029).** When the target has a known peak (shopping hours, event times), schedule big runs outside it, in the site's local time. Because it lowers the impact on real users.

Done when: a declared crawl-delay is read in code and enforced as a floor, strain signals have defined triggers and actions in the config, and large runs have a schedule window.

## Caching and conditional requests

- **Cache every response and never re-fetch what you hold (R030).** Fetch once, analyze many times. Check the cache before the network. Because it saves requests, cost, and block risk. Raw storage rules are in [crawl-state-and-storage.md](crawl-state-and-storage.md).
- **Use conditional requests (R031).** Send the stored ETag or Last-Modified value. Treat a 304 as "unchanged, keep the stored copy". Add a freshness window: skip pages fetched more recently than the window. Because a 304 costs almost nothing compared with a full download.

Generic starting point: set the freshness window from how often the content really changes (daily for prices, weekly for catalogs), then adjust from the measured change rate.

Done when: a second run over the same URLs inside the window sends no requests or only conditional ones, and the run report shows cache hits and 304s.

## Browser waits

- **Wait on conditions with a timeout (R032).** Wait for an element to appear or the network to go quiet. Always set a maximum wait. Never use a fixed sleep. Because fixed waits are both flaky (too short) and slow (too long).

Done when: no fixed sleep remains in browser code, and each wait names its condition and its timeout.

## Stop-aware waits

- **Make every long wait abortable (R033).** Sleeps, backoffs, and pauses must end at once when the stop signal arrives. Because otherwise shutdown hangs.
- **Re-check the pause state right before sending.** A pause may begin while a worker is waiting. Because the request would otherwise go out during a pause.

Done when: a test sets the stop signal during a long wait and the worker exits promptly, and a test starts a pause during a wait and no request is sent.
