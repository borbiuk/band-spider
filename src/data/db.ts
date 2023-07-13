import { logger } from '../common/logger';
import { Account } from '../models/account';
import { Album } from '../models/album';
import { Track } from '../models/track';

const sqlite3 = require('sqlite3').verbose();

// Function to get the database connection
const getDb = () => {
	return new sqlite3.Database('data/database.sqlite');
};

// Function to create the database tables
export const createTables = (): Promise<void> => {
	const db = getDb();
	return new Promise<void>((resolve, reject) => {
		db.serialize(() => {
			db.run(`
                CREATE TABLE IF NOT EXISTS Account
                (
                    id
                    INTEGER
                    PRIMARY
                    KEY,
                    url
                    TEXT
                    UNIQUE
                )
			`, (err) => {
				if (err) {
					reject(err);
					return;
				}

				db.run(`
          CREATE TABLE IF NOT EXISTS Album (
            id INTEGER PRIMARY KEY,
            url TEXT UNIQUE
          )
        `, (err) => {
					if (err) {
						reject(err);
						return;
					}

					db.run(`
            CREATE TABLE IF NOT EXISTS Track (
              id INTEGER PRIMARY KEY,
              url TEXT UNIQUE
            )
          `, (err) => {
						if (err) {
							reject(err);
							return;
						}

						db.run(`
              CREATE TABLE IF NOT EXISTS AlbumToAccount (
                albumId INTEGER,
                accountId INTEGER,
                FOREIGN KEY (albumId) REFERENCES Album(id),
                FOREIGN KEY (accountId) REFERENCES Account(id),
                PRIMARY KEY (albumId, accountId)
              )
            `, (err) => {
							if (err) {
								reject(err);
								return;
							}

							db.run(`
                CREATE TABLE IF NOT EXISTS TrackToAccount (
                  trackId INTEGER,
                  accountId INTEGER,
                  FOREIGN KEY (trackId) REFERENCES Track(id),
                  FOREIGN KEY (accountId) REFERENCES Account(id),
                  PRIMARY KEY (trackId, accountId)
                )
              `, (err) => {
								if (err) {
									reject(err);
									return;
								}

								resolve(null);
							});
						});
					});
				});
			});
		});
	})
		.finally(() => {
			db.close();
		});
};

export const insertAccount = (url): Promise<number> => {
	return new Promise<number>((resolve, reject) => {
		const db = getDb();
		db.run('INSERT OR IGNORE INTO Account (url) VALUES (?)', url,function (error) {
			if (error) {
				reject(error);
			} else {
				resolve(this.lastID);
			}

			db.close();
		});
	});
};

export const insertAlbum = (url): Promise<number> => {
	return new Promise<number>((resolve, reject) => {
		const db = getDb();
		db.run('INSERT OR IGNORE INTO Album (url) VALUES (?)', url,function (error) {
			if (error) {
				reject(error);
			} else {
				resolve(this.lastID);
			}

			db.close();
		});
	});
};

export const insertTrack = (url): Promise<number> => {
	return new Promise<number>((resolve, reject) => {
		const db = getDb();
		db.run('INSERT OR IGNORE INTO Track (url) VALUES (?)', url,function (error) {
			if (error) {
				reject(error);
			} else {
				resolve(this.lastID);
			}

			db.close();
		});
	});
};

export const insertAlbumToAccount = (albumId, accountId): Promise<boolean> => {
	return new Promise<boolean>((resolve, reject) => {
		const db = getDb();
		db.run('INSERT OR IGNORE INTO AlbumToAccount (albumId, accountId) VALUES (?, ?)', albumId, accountId, function (err) {
			if (err) {
				reject(err);
			} else {
				if (this.changes > 0) {
					resolve(true);
				} else {
					logger.warning(`Relationship already exists between albumId: ${albumId} and accountId: ${accountId}`);
					resolve(false);
				}
			}
		});
		db.close();
	});
};

export const insertTrackToAccount = (trackId, accountId): Promise<boolean> => {
	return new Promise<boolean>((resolve, reject) => {
		const db = getDb();
		db.run('INSERT OR IGNORE INTO TrackToAccount (trackId, accountId) VALUES (?, ?)', trackId, accountId, function (err) {
			if (err) {
				reject(err);
			} else {
				if (this.changes > 0) {
					resolve(true);
				} else {
					logger.info(`Relationship already exists between trackId: ${trackId} and accountId: ${accountId}`);
					resolve(false);
				}
			}
		});
		db.close();
	});
};

export const getAccountId = (accountUrl): Promise<number> => {
	return new Promise<number>((resolve, reject) => {
		const db = getDb();
		db.get('SELECT id FROM Account WHERE url = ?', accountUrl, (err, row) => {
			if (err) {
				reject(err);
			} else {
				if (row) {
					resolve(row.id);
				} else {
					resolve(null);
				}
			}
		});
		db.close();
	});
};

export const getAlbumId = (albumUrl): Promise<number> => {
	return new Promise<number>((resolve, reject) => {
		const db = getDb();
		db.get('SELECT id FROM Album WHERE url = ?', albumUrl, (err, row) => {
			if (err) {
				reject(err);
			} else {
				if (row) {
					resolve(row.id);
				} else {
					resolve(null);
				}
			}
		});
		db.close();
	});
};

export const getTrackId = (trackUrl): Promise<number> => {
	return new Promise<number>((resolve, reject) => {
		const db = getDb();
		db.get('SELECT id FROM Track WHERE url = ?', trackUrl, (err, row) => {
			if (err) {
				reject(err);
			} else {
				if (row) {
					resolve(row.id);
				} else {
					resolve(null);
				}
			}
		});
		db.close();
	});
};

export const getAllAccounts = (): Promise<Account[]> => {
	const db = getDb();

	return new Promise<Account[]>((resolve, reject) => {
		db.all('SELECT * FROM Account', (err, rows) => {
			if (err) {
				reject(err);
			} else {
				resolve(rows);
			}
		});
	})
		.finally(() => {
			db.close();
		});
};

export const getAllAlbums = (): Promise<Album[]> => {
	const db = getDb();

	return new Promise<Album[]>((resolve, reject) => {
		db.all('SELECT * FROM Album', (err, rows) => {
			if (err) {
				reject(err);
			} else {
				resolve(rows);
			}
		});
	})
		.finally(() => {
			db.close();
		});
};

export const getAllTracks = (): Promise<Track[]> => {
	const db = getDb();

	return new Promise<Track[]>((resolve, reject) => {
		db.all('SELECT * FROM Track', (err, rows) => {
			if (err) {
				reject(err);
			} else {
				resolve(rows);
			}
		});
	})
		.finally(() => {
			db.close();
		});
};
