# Recon and access path

Use this file when you start on a new target, choose between API, feed, sitemap, HTTP and browser, or when a scraper returns empty or partial data that may mean the access path is wrong.

Goal: pick the cheapest reliable way to get the needed data, and prove it on a small sample before any bulk run.

## Should you scrape at all

Decide first. Scraping is the last resort, not the first move.

- **Look for a sanctioned source first (R001).** Check for an official API, a feed (RSS or Atom), a sitemap, a bulk export, or a licensed data provider. Use it when it gives the fields you need. Because these are stabler, cheaper, lighter on the site, and carry lower legal risk than HTML scraping.
- **Fix the contract before fetching (R016).** Write down the target fields and the success criteria. If the request is vague, ask the user one focused question. Because a clear contract avoids wasted crawling.
- **Take only what you need (R018).** List the pages and fields required, and skip the rest. Because less load means less risk and cleaner data.
- **Stop when upkeep costs more than the data is worth (R019).** Scrapers break on every redesign. If repair work keeps growing, say so and propose a replacement (provider, API, or dropping the source). Because silent endless maintenance is a hidden cost.

Do not scrape around an official API's limits. See [legal-ethics-and-safety.md](legal-ethics-and-safety.md) for the legal gates (robots.txt, terms, personal data) that run before any request.

Done when: the target fields and success criteria are written down, the sanctioned sources were checked and the result is noted ("API exists but lacks field X", "no feed"), and the legal gates are passed.

## Access-path ladder

Go one rung at a time. Stop at the first rung that gives the needed fields reliably.

| Rung | Source | Cost |
|---|---|---|
| 1 | Official API, feed, export, licensed provider | Lowest |
| 2 | Embedded JSON in the page, or an internal JSON endpoint | Low |
| 3 | Static HTML plus a parser | Medium |
| 4 | Headless browser, preferably only to discover rung 2 | Highest |

- **Plain HTTP plus a parser is the default (R003).** Use a headless browser only when the data is missing from every raw response. Because a browser costs far more memory and time, limits parallelism, and adds failure modes.
- **Prefer JSON over HTML (R002).** Use internal fetch or XHR endpoints and embedded state blobs before parsing rendered markup. Because data made for machines is cleaner and changes less often than layout.
- **Escalate one level at a time (R020).** Move up the ladder only after the level below fails with evidence. Stay inside the scope the user approved. Log which rung worked and why the lower ones did not. Because the cheapest working method is the most robust, and each step up adds cost and consent questions.

Done when: the chosen rung is named, the evidence that lower rungs fail is logged, and the log says which rung is in use.

## First cheap request

- **Start with one plain HTTP request (R004).** Read the status, the response headers, and the raw body before anything else. Because one request often shows the framework, where the data lives, and any protection signals.
- **Read signatures to find the data (R007).** Match header and markup markers (server and powered-by headers, framework root elements, script bundle names, global state variables) to the framework in use. Then search only where that framework keeps its data. Because shotgun searching wastes time and requests.
- **Compare three views per data point (R005).** For each field, compare the raw response, the rendered DOM, and the network traffic. Take the cheapest source that covers it. Because different fields can live in different places.

Done when: you can say, for each target field, which of the three views holds it and which is cheapest.

## Finding JSON endpoints and embedded data

- **Use a browser only as a discovery tool (R006).** Load the page once, watch its network calls, find the call that returns the data, then call that endpoint directly. Because direct calls are faster and more stable than UI automation.
- **Replay outside the browser (R009).** Call the endpoint from your own HTTP client. Test at least two different pages or parameter sets. Because an endpoint that only works inside the page context (tokens, cookies, signed headers) is useless to the scraper.
- **Document the contract (R014).** For each endpoint, write down the method, parameters, auth needs, pagination, and the rate limit you observed. Because the implementation needs the full contract, and the next person cannot guess it.

Endpoint contract note, one per endpoint:

```
endpoint:   <method> <url pattern>
params:     <name: meaning, required or optional>
auth:       <none | cookie | token and how it is obtained>
pagination: <page | offset | cursor, size honored, how it ends>
limits:     <observed limit, source of the observation>
verified:   <date, number of pages tested>
```

Done when: each endpoint you rely on has a contract note and has returned correct data from outside the browser on two or more pages.

## Structured data and sitemaps

- **Check structured data first (R008).** Look at JSON-LD, microdata, and OpenGraph tags. Then verify they hold every needed field, on several pages. Because they are clean but often partial.
- **Use sitemaps for discovery only (R010).** Find them through robots.txt. Compare their URL count with any total the site reports. Keep a crawl fallback (category pages, links) for gaps. Because sitemaps are often stale or partial.

Done when: structured data is either confirmed complete for the target fields or the missing fields have another source; the sitemap count is compared with a reported total, or the lack of a total is noted.

## Pagination and infinite scroll

- **Name the pagination type and the expected total before bulk (R011).** Types: page number, offset, cursor, "load more", infinite scroll. Note the total the site reports. Because a wrong pagination model gives silent truncation or endless loops.
- **For infinite scroll or "load more", find the underlying call first (R011).** Replay it with the next cursor or offset. If no call exists, use a bounded scroll loop that stops when no new items appear, and check the result against the reported total. A stable item count is never proof of completeness, because virtualized lists keep the DOM size constant.

Pagination end rules and incomplete-read marking live in [extraction-and-data-quality.md](extraction-and-data-quality.md).

Done when: pagination type, page size, and expected total are written down, and a test read of the first and last pages matches the reported total.

## Static-capable vs browser-required

- **Label each task (R012).** Mark it static-capable (raw HTTP gives the evidence) or browser-required (the data or state exists only in a live page, such as results of clicking, logged-in state shown only after script runs, or canvas content). Because a static fetch cannot prove state that exists only in a live page.
- **Never downgrade silently.** If a browser-required task cannot run in a browser, stop and report it. Do not return static data as if it were the same. Prefer a direct endpoint that gives the same evidence when you can find one.

Done when: every task has a label, and any browser-required task has either a browser path or an explicit "not done" in the report.

## Prove small before bulk

- **Run a small verified procedure first (R013).** Fetch a few items across several page types (normal, edge, last page, odd layout). Check every target field against what you see on the page. Only then scale. Because untested bulk runs fail on layout variants, pagination edges, and blocks.

Done when: a written procedure exists, each target field passed on every sampled page type, and the sample result is saved next to the procedure. Offline test and tiny live-check rules are in [testing-offline.md](testing-offline.md).

## Job bounds and scope

- **Bound every job (R017).** Set maximum pages, items, depth, run time, and bytes. Add include and exclude URL patterns. Because unbounded jobs run away in cost and load.
- **Keep the crawl to the contract (R018).** Exclude page types that carry no target field.

Starting points, to tune per task: set each cap at about twice the expected size from the reported total, so a runaway stops early but a normal run finishes.

Done when: every bound has a value written in the job config, and a run that hits a bound ends with a clear "bound reached" status, not silence.

## Per-domain notes

- **Keep short notes per domain (R015).** Record verified behavior only: which rung works, endpoint contracts, quirks, observed limits, date checked. Drop or mark a claim the moment a comparable run disproves it. Because notes reuse knowledge, and stale notes make an agent loop on false beliefs. Sites change, so "explore once, reuse forever" fails; re-check notes when output quality drops.

Done when: each note line has a date and a way it was verified, and no line contradicts the latest run.

## Vendor advice filter

- **Treat vendor advice as an optional tool choice (R021).** Never adopt a vendor fix as a default rule. Because most sources describing these fixes are written by the vendors selling them, with no evidence of success rates.

Two kinds, two bars:

| Kind | Examples | Needs |
|---|---|---|
| Disguise and evasion | Stealth patches, TLS impersonation, humanized input, browser-like agents or copied browser headers, managed unblockers | Evidence of a measured problem, plus explicit permission from the site owner |
| Infrastructure | Residential pools, managed proxy or browser hosting | Evidence of a measured problem, plus the user's approval |

Because disguise works against the site's own controls, so only the site owner can allow it, while infrastructure changes only cost and path, which is the user's call.

Done when: any vendor tool in the plan has a named problem it solves, a measurement showing the problem, and the approval its kind needs, recorded in the run notes.
