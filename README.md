<br/>
<div style="width: 100%; display: flex; flex-direction: column; align-items: center; background: linear-gradient(to right, #2b809d, #1d5669, #2b809d); padding: 20px; border-radius: 15px; margin: 10px 0;">
    <img src="./assets/logo.png" alt="band-play logo" style="height: 140px; margin-bottom: -20px; border-radius: 10px;" />
    <h1 style="margin-top: 10px; margin-bottom: -8px; color: rgb(17 24 39); font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;">Band Spider</h1>
</div>

**band-spider** is a web scraper for [bandcamp](bandcamp.com). It stores information about albums, tracks, their tags,
labels, and accounts that purchased them.

## 🛠️ Installation

Node.js `^22.13.0 || >=24.11.0` is needed; `.nvmrc` pins Node 26. Clone the repository and install the exact
versions from the lockfile:

```shell
  git clone https://github.com/borbiuk/band-spider.git \
  && cd band-spider \
  && npm ci
```

`better-sqlite3` 13 is used on purpose, although TypeORM 1.1 lists `^12` as its peer. The `overrides` entry in
`package.json` makes TypeORM use the same version, so no `--legacy-peer-deps` is needed.

## 📦 Packages

The code is split into npm workspaces in `packages/`. `npm run build` builds all of them with TypeScript project
references (`tsc -b`), and `npm test` builds and runs the tests of every package.

| Package | Content |
|---|---|
| `@band-spider/contracts` | zod schemas and types for the DB service API (requests, responses, page data, statistics). It depends only on zod. |
| `@band-spider/core` | Domain types, the `CrawlStore` interface, page readers and parsing, `HttpClient`, the spider loop. It does not use TypeORM or SQLite. |
| `@band-spider/storage-sqlite` | TypeORM entities, repositories, `BandDatabase` and `LocalCrawlStore`. |
| `@band-spider/cli` | The entry point (`dist/index.js`) that the npm scripts run. |
| `@band-spider/db-service` | A Fastify HTTP service on 127.0.0.1 that owns the DB and serves the `CrawlStore` API. Start it with `npm run db:service`. Settings: `DB_SERVICE_HOST`, `DB_SERVICE_PORT` (default 4100), `DB_SERVICE_TOKEN` (optional bearer token, /health stays open), `DB_SERVICE_LEASE_MS`, `BAND_DB_PATH`. |
| `@band-spider/crawler` | A crawler process. It reads URLs from the DB service over HTTP, fetches and parses the pages, and sends the results back. It knows nothing about the DB. Start it with `npm run crawler:items` or `npm run crawler:accounts`. Settings: `CRAWLER_DB_URL` (required, for example `http://127.0.0.1:4100`), `CRAWLER_DB_TOKEN`, `CRAWLER_TYPE` (`item` or `account`), `CRAWLER_REVERSE`, `CRAWLER_WORKERS`, `CRAWLER_MIN_DELAY_MS`, `CRAWLER_MAX_DELAY_MS`, `CRAWLER_PROXY`. The proxy is used only for page requests, never for the DB service. When started with fork, it also takes a `{ type: 'config', config }` message and a `{ type: 'stop' }` message, and sends `started`, `progress` and `stopped` messages. |
| `@band-spider/admin` | The admin backend: a JSON API on 127.0.0.1 that starts, stops, restarts and watches the DB service and the crawlers (child processes started with fork). Crawlers start only after the DB service is ready, and stopping the admin stops all children. Start it with `npm run admin`. Settings are saved in `~/.band-spider/admin-config.json` (`ADMIN_CONFIG_PATH` overrides it). Env: `ADMIN_HOST` (default 127.0.0.1), `ADMIN_PORT` (default 4200). Security: the admin checks the Host header (127.0.0.1, localhost or [::1] with its own port) and the Origin header of state-changing requests, and every route except `/health` needs a random session token made at each start. The startup log prints the URL `http://127.0.0.1:4200/session?token=...`, which sets the token cookie. Scripts can send `Authorization: Bearer <token>` or `X-Admin-Token`. `GET /config` and `PUT /config` show secrets (DB service token, proxy passwords) as `********`, and a saved secret is kept when the masked value is sent back. The admin also serves a web page at `/` (static HTML and htmx from the npm package, no CDN, no build step): DB service status and controls, a crawler list with add, edit and remove (type, newest first, workers, delays, proxy none, url or Webshare), start, stop and restart for each process and for all, and live state and logs over server-sent events (`GET /events`). Open the URL from the startup log once, it sets the cookie. The page uses the `/fragments/*` routes. Routes: `GET/PUT /config`, `GET /status`, `POST /start-all`, `POST /stop-all`, `POST /db/start`, `/db/stop`, `/db/restart`, `GET /db/logs`, `POST /crawlers/:name/start`, `/stop`, `/restart`, `GET /crawlers/:name/logs`. |

## 🚀 Run

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

Every script builds the app first (`npm run build`) and then runs `node ./packages/cli/dist/index.js` with its flags.
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

Pages are read with plain HTTP requests, with a random pause of 400-450 ms between requests and a shared pause after
HTTP 429. No browser is needed.

## 🧪 Tests

```shell
npm test
```

The tests use temp SQLite files and a local HTTP server; they do not touch `band_db.sqlite` or the network. CI runs
them on Node 22, 24 and 26 for every pull request.

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
