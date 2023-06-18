const {log} = require("../common/log");
const sqlite3 = require('sqlite3').verbose();

// Function to get the database connection
const getDb = () => {
	return new sqlite3.Database('data/database.sqlite');
};

// Function to create the database tables
const createTables = () => {
	const db = getDb();
	return new Promise((resolve, reject) => {
		db.serialize(() => {
			db.run(`
                CREATE TABLE IF NOT EXISTS Account
                (
                    Id
                    INTEGER
                    PRIMARY
                    KEY,
                    Url
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
            Id INTEGER PRIMARY KEY,
            Url TEXT UNIQUE
          )
        `, (err) => {
					if (err) {
						reject(err);
						return;
					}

					db.run(`
            CREATE TABLE IF NOT EXISTS Track (
              Id INTEGER PRIMARY KEY,
              Url TEXT UNIQUE
            )
          `, (err) => {
						if (err) {
							reject(err);
							return;
						}

						db.run(`
              CREATE TABLE IF NOT EXISTS AlbumToAccount (
                AlbumId INTEGER,
                AccountId INTEGER,
                FOREIGN KEY (AlbumId) REFERENCES Album(Id),
                FOREIGN KEY (AccountId) REFERENCES Account(Id),
                PRIMARY KEY (AlbumId, AccountId)
              )
            `, (err) => {
							if (err) {
								reject(err);
								return;
							}

							db.run(`
                CREATE TABLE IF NOT EXISTS TrackToAccount (
                  TrackId INTEGER,
                  AccountId INTEGER,
                  FOREIGN KEY (TrackId) REFERENCES Track(Id),
                  FOREIGN KEY (AccountId) REFERENCES Account(Id),
                  PRIMARY KEY (TrackId, AccountId)
                )
              `, (err) => {
								if (err) {
									reject(err);
									return;
								}

								resolve();
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

const insertAccount = (url) => {
	const db = getDb();

	db.run('INSERT OR IGNORE INTO Account (Url) VALUES (?)', url);

	db.close();
};

const insertAlbum = (url) => {
	const db = getDb();

	db.run('INSERT OR IGNORE INTO Album (Url) VALUES (?)', url);

	db.close();
};

const insertTrack = (url) => {
	const db = getDb();

	db.run('INSERT OR IGNORE INTO Track (Url) VALUES (?)', url);

	db.close();
};

const insertAlbumToAccount = (albumId, accountId) => {
	return new Promise((resolve, reject) => {
		const db = getDb();
		db.run('INSERT OR IGNORE INTO AlbumToAccount (AlbumId, AccountId) VALUES (?, ?)', albumId, accountId, function (err) {
			if (err) {
				reject(err);
			} else {
				if (this.changes > 0) {
					resolve();
				} else {
					log(`Relationship already exists between AlbumId: ${albumId} and AccountId: ${accountId}`);
					resolve();
				}
			}
		});
		db.close();
	});
};

const insertTrackToAccount = (trackId, accountId) => {
	return new Promise((resolve, reject) => {
		const db = getDb();
		db.run('INSERT OR IGNORE INTO TrackToAccount (TrackId, AccountId) VALUES (?, ?)', trackId, accountId, function (err) {
			if (err) {
				reject(err);
			} else {
				if (this.changes > 0) {
					resolve();
				} else {
					log(`Relationship already exists between TrackId: ${trackId} and AccountId: ${accountId}`);
					resolve();
				}
			}
		});
		db.close();
	});
};

const getAccountId = (accountUrl) => {
	return new Promise((resolve, reject) => {
		const db = getDb();
		db.get('SELECT Id FROM Account WHERE Url = ?', accountUrl, (err, row) => {
			if (err) {
				reject(err);
			} else {
				if (row) {
					resolve(row.Id);
				} else {
					resolve(null);
				}
			}
		});
		db.close();
	});
};

const getAlbumId = (albumUrl) => {
	return new Promise((resolve, reject) => {
		const db = getDb();
		db.get('SELECT Id FROM Album WHERE Url = ?', albumUrl, (err, row) => {
			if (err) {
				reject(err);
			} else {
				if (row) {
					resolve(row.Id);
				} else {
					resolve(null);
				}
			}
		});
		db.close();
	});
};

const getTrackId = (trackUrl) => {
	return new Promise((resolve, reject) => {
		const db = getDb();
		db.get('SELECT Id FROM Track WHERE Url = ?', trackUrl, (err, row) => {
			if (err) {
				reject(err);
			} else {
				if (row) {
					resolve(row.Id);
				} else {
					resolve(null);
				}
			}
		});
		db.close();
	});
};

const getAllAccounts = () => {
	const db = getDb();

	return new Promise((resolve, reject) => {
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

const getAllAlbums = () => {
	const db = getDb();

	return new Promise((resolve, reject) => {
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

const getAllTracks = () => {
	const db = getDb();

	return new Promise((resolve, reject) => {
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

module.exports = {
	createTables,
	getAccountId,
	getAlbumId,
	getAllAccounts,
	getAllAlbums,
	getAllTracks,
	getTrackId,
	insertAccount,
	insertAlbum,
	insertAlbumToAccount,
	insertTrack,
	insertTrackToAccount,
};
