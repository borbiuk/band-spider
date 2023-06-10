const {log} = require("./log");
const sqlite3 = require('sqlite3').verbose();

// Function to get the database connection
const getDb = () => {
	return new sqlite3.Database('data/database.sqlite');
};

// Function to create the database tables
const createTables = () => {
	return new Promise((resolve, reject) => {
		const db = getDb();

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
				} else {
					db.run(`
                        CREATE TABLE IF NOT EXISTS Album
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
						} else {
							db.run(`
                                CREATE TABLE IF NOT EXISTS AlbumToAccount
                                (
                                    AlbumId
                                    INTEGER,
                                    AccountId
                                    INTEGER,
                                    FOREIGN
                                    KEY
                                (
                                    AlbumId
                                ) REFERENCES Album
                                (
                                    Id
                                ),
                                    FOREIGN KEY
                                (
                                    AccountId
                                ) REFERENCES Account
                                (
                                    Id
                                ),
                                    PRIMARY KEY
                                (
                                    AlbumId,
                                    AccountId
                                )
                                    )
							`, (err) => {
								if (err) {
									reject(err);
								} else {
									resolve();
								}
							});
						}
					});
				}
			});
		});
	});
};


// Function to insert an account URL into the database
const insertAccount = (url) => {
	const db = getDb();

	db.run('INSERT OR IGNORE INTO Account (Url) VALUES (?)', url);

	db.close();
};

// Function to insert an album URL into the database
const insertAlbum = (url) => {
	const db = getDb();

	db.run('INSERT OR IGNORE INTO Album (Url) VALUES (?)', url);

	db.close();
};

// Function to insert a relationship between an album and an account into the database
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

// Function to retrieve the account ID from the database
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

module.exports = {
	getAlbumId,
	getAccountId,
	createTables,
	insertAccount,
	insertAlbum,
	insertAlbumToAccount,
};
