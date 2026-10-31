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

To link tags to super tags:

```shell
npm run superTag
```

Every script builds the app first (`npm run build`) and then runs `node ./dist/index.js` with its flags.

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

`Ctrl-C` (or `SIGTERM`) lets the current URL finish, closes the browsers and the DB, and exits with code 130 (143 for
`SIGTERM`). Press `Ctrl-C` again to stop at once. A fatal error exits with code 1.

## 🌐 How pages are read

By default pages are read with plain HTTP requests (no Chrome is started), with a random pause of 0.5-1.5 s between
requests and a shared pause after HTTP 429. To read pages with Puppeteer instead, add the `--browser` flag:

- `npm run db:items:browser`
- `npm run db:accounts:browser`

Install the Chrome version that Puppeteer needs once:

```shell
npm run install-browser
```

To use a [browserless](https://www.browserless.io/) container instead of a local Chrome, start it with
`bash scripts/browserless.sh` and run `npm run docker:db:items` or `npm run docker:db:accounts`.

## 🕵️ Debug Mode

The debug commands open a visible browser, so they always run with `--browser`:

- `npm run debug:db:accounts`
- `npm run debug:db:items`

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
