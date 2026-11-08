# Identity and proxies

Use this file when you set headers, sessions or proxies, when you see IP blocks or challenges, or when you handle credentials.

Highest-impact rules first: sticky egress (R039), one crawler per egress (R040), egress health (R041), secrets (R045), challenges (R048), honest identity (R034, R035).

Related files:
- Pacing per egress: [politeness-and-pacing.md](politeness-and-pacing.md)
- What a response means (page vs egress): [error-classification.md](error-classification.md)
- Retry and 429 handling: [retries-and-backoff.md](retries-and-backoff.md)
- Robots, terms, access controls: [legal-ethics-and-safety.md](legal-ethics-and-safety.md)

Vocabulary: an **egress** is the network path your requests leave from (one IP, one proxy, or one proxy session). Every rule below talks about egress, not "proxy", because a direct connection is also an egress.

---

## Honest identification

**R034 - Identify yourself.** Send a named user agent with a contact (URL or email) wherever the site accepts bots. Never ship the default string of your HTTP library.
Because: operators can reach you before they block you, and library defaults are flagged anyway.

Rules:
- Name the agent after your job, not after a browser. Add a version and a contact.
- Use the same agent name in your robots.txt checks (see [legal-ethics-and-safety.md](legal-ethics-and-safety.md)).
- If a site refuses honest bots, take that as a policy answer. Stop, ask the owner for permission, or use an official source. Do not disguise the agent to get in.
  Because: disguise conflicts with terms and with the honesty stance of this skill.
- Browser-like agents, TLS impersonation and copied browser headers are disguise tools. The permission rule for them is in [recon-and-access-path.md](recon-and-access-path.md), "Vendor advice filter".

Done when: every request carries the named agent with a contact, and no code path falls back to a library default.

---

## Consistent headers and identity

**R035 - Send a complete, consistent header set.** Set the agent, Accept, Accept-Language, Accept-Encoding and a fitting Referer together.
Because: missing or contradicting headers give wrong responses (wrong language, odd encoding) and are a strong anomaly signal.

Rules:
- Pick Accept-Language for the content you want, and keep it equal to the geo choice in "Geo matching" below.
- Set Referer to the page a real visitor would come from (the listing page for a detail page). Leave it out for a first entry URL.
- Only advertise encodings you can decode.
- Check the full set against one real response once. Then fix it in one place in code.

**R036 - Keep one coherent identity per target and per session.** An identity is the agent, headers, language, cookies and egress together. Hold it fixed. Do not randomize any part per request.
Because: detection scores contradictions between signals, and "rotate the user agent alone" gives a different agent on a stable IP, which looks worse than a fixed one.

Rules:
- Choose the identity once per session. Reuse it for the session's whole life.
- Different targets may use different identities. One target sees one.
- Never mix parts from two identities (agent A with headers built for agent B).

Done when: two requests of one session differ only in URL, Referer and cookies the server set.

---

## Sessions

**R037 - Use a session only when the site needs state.** Then keep its cookies and pin it to one egress.
Because: unneeded sessions add linkage and failure; needed ones break when the IP changes mid-flow.

Decision:

| Site needs | Do |
|---|---|
| Nothing stateful (public GET pages) | Stateless requests. No cookie jar kept across pages. |
| Cookies set by the first page, a consent flag, a CSRF token, a cart or search context | One session: keep every cookie the server sets and send them back. |
| A flow of several dependent requests | One session, one egress, one identity for the whole flow. |

Rules:
- Store session and egress together. Never move a live session to another egress.
- When an egress dies, end its sessions and start new ones on another egress. Do not resume them.
- Expire sessions on age or on the first sign of a reset (login redirect, new cookie demand).

Done when: each session lists its egress, and no request of a session left from a different one.

---

## When to use proxies

**R038 - Add a proxy only for an IP-level need.** Start with the cheapest tier that works. Climb one tier at a time and stop at the first that works.
Because: proxies cost money, add a failure source, and rarely fix non-IP problems.

IP-level needs:
- Your own IP is blocked or capped by volume.
- You need a different region for geo content.
- You must spread total volume over several IPs, each kept inside its own budget.

Not IP-level (a proxy will not help): fingerprint or TLS challenges, script challenges, missing headers, broken parsing, a site that refuses honest bots. See "Challenges and honeypots".

Tier order (generic): direct connection, then datacenter egress, then pricier egress types, then a managed service. Residential pools and managed proxy services are optional tools; managed unblockers are disguise tools. The evidence and permission rule for both is in [recon-and-access-path.md](recon-and-access-path.md), "Vendor advice filter".

**R046 - Keep your own services off the scraping proxy.** Calls from workers to your queue, store or admin service go direct.
Because: you pay proxy bandwidth for internal traffic, you couple internal failures to proxy failures, and you expose internal addresses to a third party.
Do: set the proxy only on the target-facing client. Add an explicit no-proxy list for internal hosts and loopback.

Done when: the proxy is set on the target client only, and a test shows an internal call bypasses it.

---

## Sticky egress vs rotation

**R039 - Pin each worker or session to one egress. Never rotate to escape a rate limit.**
Because: rotation hides bans, spreads them across the whole pool, breaks sessions, and an identity that changes every request is itself an anomaly.

Allowed use of rotation: spread volume across IPs, with each IP held inside its own pacing budget. Assign an egress to a worker at start. Move it only on health failure (see below).

Forbidden use: a 429 or a block on egress A, so send the same URLs through egress B. Instead: pause A for that host (see [retries-and-backoff.md](retries-and-backoff.md), "Rate-limit gate per egress and host"), slow down, and re-check.

Never rotate inside a stateful flow (R037).

**R040 - One crawler per egress IP, or a shared gate.** If several crawlers use one IP, they all pass through one pacing gate.
Because: two independent crawlers on one IP double its real request rate, and each one thinks it is polite.
Do: give each egress one owner, or one gate object that every crawler on that egress shares. Check the mapping at start. Refuse to start a second crawler on an owned egress unless it joins the gate.

Done when: the egress-to-crawler map shows at most one pacing gate per IP and host.

---

## Proxy pool health and lifecycle

**R041 - Track health per egress. Escalate warn, then pause and re-check, then halt for a human.**
Because: a dead or blocked egress otherwise burns the queue or idles forever. Egress downtime must not count as URL failures (see [error-classification.md](error-classification.md), "What counts against a URL").

Escalation ladder (generic):

| Level | Trigger (egress-level failures such as resets, refused, auth errors, timeouts, failed control checks; 429s stay with the per-host gate) | Action |
|---|---|---|
| Warn | Failure share or streak passes a first threshold | Log and count it. Keep working. |
| Pause | Share or streak passes a second threshold, or a control check fails | Stop sending on that egress. Release in-flight URLs without a failure count. Re-check with a control request on a timer. |
| Halt | Repeated failed re-checks, or no healthy egress left | Stop the worker and ask for a human. Do not retry forever. |

Start thresholds low for network errors and looser for page-level misses, then tune from your observed error rates. Control requests are defined in [error-classification.md](error-classification.md).

Resume only after a control request passes. Reset the failure counters at that moment.

**R042 - Manage the pool lifecycle.** When you run a managed pool of egresses shared by several crawlers, do three things. A single-process scraper with one egress can skip this rule.
1. Resolve proxy credentials fresh at each worker start, from the secret store. Do not cache a list in a long-lived file.
2. Show which crawler uses which egress, in an admin view or status output.
3. Refuse to remove an egress that a crawler is using. Drain the crawler first.

Because: stale lists give auth failures, and removing a live egress breaks running crawlers with confusing errors.

Done when: removal of an in-use egress returns a refusal that names the crawler, and a restarted worker picks up changed credentials.

---

## Challenges and honeypots

**R048 - A CAPTCHA or WAF challenge means stop or back off.** Do not solve it, bypass it or mock the check. No solving services and no evasion tooling by default.
Because: defeating it is an arms race and often crosses a legal line.

On the first challenge:
1. Pause the host on every egress. Keep its released URLs off other egresses until the probe passes, because sending them through another egress is rotation to escape (R039).
2. Mark the response as a block, not as page content (see [error-classification.md](error-classification.md), "Content over status").
3. Back off for a long, jittered period. Then probe with one gentle request from the original egress.
4. If challenges continue, lower the rate, re-check robots and terms, and ask the owner for permission or an official source.
5. Report it in the run report.

Watch for early signs: a slow rise in 403s, interstitial pages, redirects to a verification path.

**R043 - Rotation does not fix fingerprint, TLS or script challenges.** A fresh IP carrying the same giveaway is flagged again.
Because: those checks look at the client, not the address.
Do: classify the block type first (see [error-classification.md](error-classification.md), "Remedy by block type"). If it is not IP-level, do not buy more IPs.

**R049 - Skip honeypots.** Do not follow hidden links and do not fill hidden form fields. Skip elements that are invisible by style, off-screen, zero-sized, or marked hidden.
Because: they exist only to identify bots, and a hit flags your whole identity.
Do: select links by the visible, intended navigation structure. Never submit a form's hidden fields except tokens the page itself supplies for that form.

Done when: on a challenge you stop and report, and no link or field selector reaches hidden elements.

---

## Geo matching

**R044 - When content depends on location, match locale, timezone and Accept-Language to the egress location.**
Because: a mismatch returns wrong prices or languages and looks suspicious.

Rules:
- Decide the target region first. Choose an egress in that region. Then set language, locale and timezone to fit it.
- Keep the region fixed per session (R036, R037).
- If content does not depend on location, skip this and use one neutral setup.
- Record the region next to the scraped data, so a reader knows which market it represents.

Done when: the data records its region, and the egress, language and timezone agree.

---

## Secrets and profiles

**R045 - Keep secrets out of code, logs, errors, reports and saved output.** Secrets: proxy passwords, API keys, cookies, tokens, session ids.
Because: a leaked credential is paid for, abused, or exposed in shared artifacts.

Rules:
- Load secrets from the environment or a secret store at start.
- Redact proxy URLs, auth headers and cookies before logging. Log the egress by an alias, not by its credentialed URL.
- Strip secrets from exception text before it is stored or shown. Network errors often embed the full proxy URL.
- Scrub secrets from saved raw responses, fixtures and reports (see [testing-offline.md](testing-offline.md)).
- Never put secrets in query strings or in files committed to version control.

**R047 - Treat browser profiles and cookie stores as credentials.** Crawl untrusted sites only with a fresh, empty profile. Keep logged-in profiles away from crawling.
Because: hostile pages can read or abuse stored sessions, and session state bleeds between targets.
Do: use a throwaway profile per job or per target. Delete it when the job ends. Never reuse a personal or authenticated profile for open crawling. Authenticated scraping needs explicit user-provided access (see [legal-ethics-and-safety.md](legal-ethics-and-safety.md)).

Done when: a search of the code, logs and a sample report finds no secret values, and untrusted crawls use disposable profiles.
