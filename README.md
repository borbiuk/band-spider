<br/>
<div style="width: 100%; display: flex; flex-direction: column; align-items: center; background: linear-gradient(to right, #2b809d, #1d5669, #2b809d); padding: 20px; border-radius: 15px; margin: 10px 0;">
    <img src="./assets/logo.png" alt="band-play logo" style="height: 140px; margin-bottom: -20px; border-radius: 10px;" />
    <h1 style="margin-top: 10px; margin-bottom: -8px; color: rgb(17 24 39); font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;">Band Spider</h1>
</div>

**band-spider** is a web scraper for [bandcamp](bandcamp.com). It stores information about albums, tracks, their tags,
labels, and accounts that purchased them.

## 🛠️ Installation

Node.js 26 or newer is needed; `.nvmrc` pins Node 26. Clone the repository and install the exact
versions from the lockfile:

```shell
  git clone https://github.com/borbiuk/band-spider.git \
  && cd band-spider \
  && npm ci
```

`better-sqlite3` 13 is used on purpose, although TypeORM 1.1 lists `^12` as its peer. The `overrides` entry in
`package.json` makes TypeORM use the same version, so no `--legacy-peer-deps` is needed.

## 🏗️ Architecture

There are three kinds of processes:

```
        +--------------------------------+
        |   admin (127.0.0.1:4200)       |  web page: start, stop, configure, monitor
        +---------------+----------------+
                        | fork + IPC (start, stop, config, metrics)
         +--------------+---------------+
         v                              v
+-------------------+  HTTP/JSON  +----------------------+
| DB service        |<------------| crawler (N procs)    |---> Bandcamp
| the only process  | claim, save | own pacing, own      |     direct or through
| that opens SQLite | release     | pause after 429      |     a proxy
+-------------------+             +----------------------+
```

- **DB service**: the only process that opens the database. It hands out URLs with a lease, saves results one at a
  time and keeps statistics.
- **crawler**: fetches and parses Bandcamp pages and sends the results to the DB service. It knows nothing about the
  database. Each crawler has its own pacing and its own pause after HTTP 429 (shared by all its workers, because they share one
  IP), and runs either through one proxy or from the local IP. A crawler does not exit when the queue is empty: it
  waits (`CRAWLER_IDLE_MS`, default 30 s) and asks again.
- **admin**: a web page on 127.0.0.1 that starts, stops, configures and monitors the DB service and all crawlers.

Code depends on small interfaces (`CrawlStore`, `ProxySource`, `ProcessLauncher`, `ConfigStore`), and every process
has one composition root that wires them by hand.

## 📦 Packages

The code is split into npm workspaces in `packages/`. `npm run build` builds all of them with TypeScript project
references (`tsc -b`), and `npm test` builds and runs the tests of every package.

| Package | Content |
|---|---|
| `@band-spider/contracts` | zod schemas and types for the DB service API. It depends only on zod. |
| `@band-spider/core` | Domain types, the `CrawlStore` interface, page readers and parsing, `HttpClient`, `ProxySource`, the spider loop. It does not use TypeORM or SQLite. |
| `@band-spider/storage-sqlite` | TypeORM entities, repositories, `BandDatabase` and `LocalCrawlStore`. |
| `@band-spider/cli` | The debug entry point (`dist/index.js`) with the DB in the same process. |
| `@band-spider/db-service` | The Fastify DB service. |
| `@band-spider/crawler` | The crawler process and `RemoteCrawlStore`. |
| `@band-spider/admin` | The admin API, the web page and the process supervisor. |

## 🧭 Run with the admin

This is the normal way to run the app. One command starts the admin:

```shell
npm run admin
```

The startup log prints a URL like `http://127.0.0.1:4200/session?token=...`. Open it once in a browser: it sets the
session cookie and shows the admin page. From the page you can:

- start, stop and restart the DB service, each crawler, or everything at once;
- add, edit and remove crawlers (items or accounts, proxy; workers, delays, idle wait and newest first are under "More settings"
  and only saved when they differ from the defaults);
- watch the state, the logs, the speed, HTTP 429 answers and the queue that is left;
- press **View** to see how well the crawl fills the DB: new items, accounts and links, the share of new records per
  source, collection and wishlist, the queue and when it will be empty, and the efficiency of each crawler.
  The DB service counts these with `GET /stats` (`flow`, since it started) and `GET /totals` (the rows of the DB).
  Counting a big DB takes seconds and blocks the service, so `/totals` is cached for five minutes and the admin reads it
  only while the View is open.

Crawlers start only after the DB service is ready. Stopping the admin stops all children.

### Crawlers and proxies

Add one crawler per IP. Each crawler has one of these proxy settings:

- **none**: the crawler uses the local IP;
- **url**: a proxy URL such as `http://user:pass@host:port`;
- **Webshare**: put `"webshare": {"apiKey": "..."}` in the admin config (`PUT /config`), then give the crawler the
  proxy `{"kind":"webshare-list","index":0}` or `{"kind":"webshare-list","id":"..."}`. At each crawler start the admin
  loads the proxy list from the Webshare API, takes that proxy and sends its URL to the crawler.

- **pool**: a proxy from the proxy pool that you imported from a file (see below). The crawler setting is
  `{"kind":"pool","key":"host:port"}`. At each crawler start the admin builds `http://user:pass@host:port` from the pool.
  If the key is not in the pool, the start fails with a clear message.

#### Import a proxy list file

Webshare can export the proxies as a `.txt` file, one proxy per line, `host:port:username:password`
(Windows or Unix line endings). Lines in the form `http://username:password@host:port` also work. Empty lines and
lines that start with `#` are ignored. Same `host:port` twice in one file: the first line is kept.

1. Open the admin page and find the **Proxies** section.
2. Choose the file (it is read in your browser) or paste the list into the text box.
3. Pick the mode and press **Import**:
   - `append` (default): new `host:port` entries are added, an existing one gets the new user name and password;
   - `replace`: the list becomes the whole pool. It is refused if it would remove a proxy that a crawler uses.
4. The page shows "N added, M updated, K skipped" and the numbers of the bad lines (the text of a bad line is never
   shown, because it has a password).
5. In **Add crawler** or **Edit**, set Proxy to `pool` and choose a `host:port`. The list shows "used by ..." for
   entries that another crawler already uses. Using one entry in two crawlers is only a warning, but the rule is one
   crawler per IP.
6. The pool list shows each proxy and the crawlers that use it. A proxy that a crawler uses cannot be deleted.
7. **Add crawlers for free proxies** creates one crawler for each proxy that no crawler uses. Choose the type next to the
   button: `item` (default), `account`, or `split` (items and accounts in turn over the free proxies, items first). The
   crawlers are named `items-1`, `items-2`, ... and `accounts-1`, ... (the next free number, so a name never clashes).
   Only the name, the type and the proxy are saved; every other setting stays at its default. The crawlers are not
   started. The page shows "N crawlers added" and refreshes the crawler table and the pool list.

The same from a script (same token and Origin rules as the other routes; passwords are never returned):

```
curl -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "$(jq -Rs '{text: ., mode: "append"}' proxies.txt)" http://127.0.0.1:4200/proxies/import
# {"added":2,"updated":0,"skipped":0,"errors":[],"duplicateLines":[]}
```

```
curl -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"type": "split"}' http://127.0.0.1:4200/proxies/free-crawlers
# {"added":2,"names":["items-1","accounts-1"]}
```

`POST /proxies/free-crawlers` adds one crawler for each free proxy (`type` is `item` (default), `account` or `split`).
With no free proxy it returns `{"added":0,"names":[]}`. `GET /proxies` lists the pool (key, host, port, username, usedBy), `DELETE /proxies/:key` deletes one entry (the key is
`host:port`, URL-encoded). The pool is saved in the admin config as `proxyPool`, and `GET /config` shows its passwords
as `********`.

The proxy is used only for page requests, never for the DB service. A crawler keeps one fixed proxy, and the pool is
not rotated after a 429.

### Admin settings and API

Settings are saved in `~/.band-spider/admin-config.json` (`ADMIN_CONFIG_PATH` overrides it). Env: `ADMIN_HOST`
(default 127.0.0.1), `ADMIN_PORT` (default 4200).

Security: the admin checks the Host header (127.0.0.1, localhost or [::1] with its own port) and the Origin header
of state-changing requests, and every route except `/health` needs a random session token made at each start.
Scripts can send `Authorization: Bearer <token>` or `X-Admin-Token`. `GET /config` and `PUT /config` show secrets
(DB service token, proxy passwords, the Webshare key) as `********`, and a saved secret is kept when the masked value
is sent back.

Routes: `GET/PUT /config`, `GET /status`, `POST /start-all`, `POST /stop-all`, `POST /db/start`, `/db/stop`,
`/db/restart`, `GET /db/logs`, `POST /crawlers/:name/start`, `/stop`, `/restart`, `GET /crawlers/:name/logs`, and
`GET /events` (server-sent events). The page is static HTML and htmx from the npm package (no CDN, no build step) and
uses the `/fragments/*` routes.

Statistics: each crawler sends metrics over IPC every minute (requests, URLs saved and failed, HTTP 429 answers,
current pause, and whether it waits for URLs). The page shows requests/min and URLs/min over the last 5 minutes, 429 per hour and the totals. The
admin reads `GET /stats` of the DB service every 5 seconds and shows the queue left and the service counters.

## 🧩 Run the processes by hand

Each process also runs alone, for example in separate terminals:

```shell
npm run db:service        # DB service on 127.0.0.1:4100
npm run crawler:items     # a crawler for items
npm run crawler:accounts  # a crawler for accounts
```

DB service env: `DB_SERVICE_HOST`, `DB_SERVICE_PORT` (default 4100), `DB_SERVICE_TOKEN` (optional bearer token,
`/health` stays open), `DB_SERVICE_LEASE_MS`, `BAND_DB_PATH`, `DB_SYNCHRONIZE`.

Crawler env: `CRAWLER_DB_URL` (required, for example `http://127.0.0.1:4100`), `CRAWLER_DB_TOKEN`, `CRAWLER_TYPE`
(`item` or `account`), `CRAWLER_REVERSE`, `CRAWLER_WORKERS` (1 to 64), `CRAWLER_MIN_DELAY_MS`,
`CRAWLER_MAX_DELAY_MS`, `CRAWLER_IDLE_MS` (wait in ms when no URL is left, `0` = exit; default 30000), `CRAWLER_PROXY`. Flags: `--account` and `--reverse`.

## 🐞 CLI debug mode

The CLI runs the spider with the database in the same process. It is kept as a debug mode and for quick local runs.
It does not use the DB service, the crawlers or the admin.

## 🚀 Run (CLI mode)

The app reads the URLs to process from the database. A new DB file is created with the schema on the first start.

To process saved accounts:

```shell
npm run db:accounts
```

To process saved tracks:

```shell
npm run db:items
```

Each run takes the unprocessed rows in batches of 400, by default the oldest first (lowest id). To start from the
newest rows (highest id) instead:

```shell
npm run db:accounts:reverse
npm run db:items:reverse
```

When an account is read again, every tab that was read to its end before is read only up to its newest
records from that read: Bandcamp lists the newest records first, so the older ones are saved already. The app keeps
these marks in the `account-scans` table; a tab without a mark (or whose marked record is gone) is read in full.

To send the requests through a proxy (a manual test option), pass its URL. Without the flag the local IP is used:

```shell
npm run build && node ./packages/cli/dist/index.js --proxy http://user:pass@host:port
```

To link tags to super tags:

```shell
npm run superTag
```

Every script builds the app first (`npm run build`) and then runs the entry point of its package with its flags.
Run the scripts from the repository root, so the DB file and `logfile.log` stay there.

### ⚙️ Settings

| Environment variable | Meaning |
|---|---|
| `BAND_DB_PATH` | Path of the SQLite file. Default: `band_db.sqlite` in the working directory. |
| `DB_SYNCHRONIZE=true` | Update the schema from the entities on start. Without it, the schema is created only for a new file. |

The app logs to the console and to `logfile.log` in the working directory (one JSON object per line). To read the
file in a readable form:

```shell
npx pino-pretty < logfile.log
```

### ⏹️ Stopping

`Ctrl-C` (or `SIGTERM`) lets the current URL finish, closes the DB, and exits with code 130 (143 for
`SIGTERM`). Press `Ctrl-C` again to stop at once. A fatal error exits with code 1.

## 🌐 How pages are read

Pages are read with plain HTTP requests. All workers of one run share one HTTP client (one IP): requests never
overlap, and a random pause of 550-700 ms is kept from the end of one request to the start of the next. A pause after
HTTP 429 stops all requests of that client. No browser is needed.

## 🧪 Tests

```shell
npm test
```

The tests use temp SQLite files and a local HTTP server; they do not touch `band_db.sqlite` or the network. CI runs
them on Node 26 for every pull request.

## 🗄️ Database maintenance

`scripts/re-create-db.sh` rebuilds `band_db.sqlite` from an SQL dump to make it smaller, and keeps the old file in
`backup/`. Stop the app first, and run the script from the `scripts` folder:

```shell
cd scripts && ./re-create-db.sh
```

## 📀 How&What data we store

<img src="./assets/db.jpg" alt="database schema">

## 🐤 What data should be added to parsing

1. Item image (The new `image` column in `items` table)
2. Wishlist relation (The new `isWishlist` column in `item-to-tag` table)
3. Account item index (The new `index` column in `item-to-account` table)
4. Labels (New `labels` and `item-to-label` tables)
