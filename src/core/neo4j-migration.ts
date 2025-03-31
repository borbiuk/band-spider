import { Repository } from 'typeorm';
import { isNullOrUndefined } from '../common/utils';
import { BandDatabase } from '../data/db';
import { AccountEntity } from '../data/entities/account-entity';
import { FollowerEntity } from '../data/entities/follower-entity';
import { ItemEntity } from '../data/entities/item-entity';
import { ItemToAccountEntity } from '../data/entities/item-to-account-entity';
import { Graph } from '../data/graph';

const batchSize: number = 50_000;
const gcIteration: number = 10 * batchSize;

export class Neo4jMigration {
	public async up(): Promise<void> {
		const db = await BandDatabase.initialize();
		const graph = await Graph.initialize();

		try {
			console.log('Migration started');
			await graph.execute(async (session) => {
				await this.createConstraints(session);
			});

			// Account
			console.time('Accounts importing finished');
			await this.loadAccount(db, graph);
			console.timeEnd('Accounts importing finished');

			// Follow
			console.time('Account Relations imported finished');
			await this.loadFollowers(db, graph);
			console.timeEnd('Account Relations imported finished');

			// Track & Album
			console.time('Items Relations imported finished');
			await this.loadItems(db, graph);
			console.timeEnd('Items Relations imported finished');

			// Track -> Album
			console.time('Items Album Relations imported finished');
			await this.createTrackToAlbumRelations(db, graph);
			console.timeEnd('Items Album Relations imported finished');

			// Account -> Item
			console.time('Items Owner Relations imported finished');
			await this.loadItemToAccountRelations(db, graph);
			console.timeEnd('Items Owner Relations imported finished');
		} catch (error) {
			console.error('Migration failed:', error);
		}
	}

	private async createConstraints(graphSession): Promise<void> {
		const constrainCheckQuery = `
			SHOW CONSTRAINTS;
		`;

		const result = await graphSession.run(constrainCheckQuery);
		const existingConstraints = result.records.map(x => x.get('name'));

		if (!existingConstraints.includes('account_id_constraint')) {
			const createIndexQuery = `
				CREATE CONSTRAINT account_id_constraint
				FOR (a:Account) REQUIRE a.id IS UNIQUE;
			`;

			console.log('Creating unique constraint for Account(id)');
			await graphSession.run(createIndexQuery);
		} else {
			console.log('Constraint for Account(id) already exists');
		}

		if (!existingConstraints.includes('album_id_constraint')) {
			const createIndexQuery = `
				CREATE CONSTRAINT album_id_constraint
				FOR (a:Album) REQUIRE a.id IS UNIQUE;
			`;

			console.log('Creating unique constraint for Album(id)');
			await graphSession.run(createIndexQuery);
		} else {
			console.log('Constraint for Album(id) already exists');
		}

		if (!existingConstraints.includes('track_id_constraint')) {
			const createIndexQuery = `
				CREATE CONSTRAINT track_id_constraint
				FOR (t:Track) REQUIRE t.id IS UNIQUE;
			`;

			console.log('Creating unique constraint for Track(id)');
			await graphSession.run(createIndexQuery);
		} else {
			console.log('Constraint for Track(id) already exists');
		}
	}

	private async loadAccount(db: BandDatabase, graph: Graph): Promise<void> {
		const repository = db.dataSource.getRepository(AccountEntity);

		const cypherQuery = `
			UNWIND $accounts AS account
			MERGE (a:Account {id: account.id})
			SET a.lastProcessingDate = account.lastProcessingDate,
				a.isBusy = account.isBusy,
				a.failedCount = toInteger(account.failedCount)
			`;

		let skip = 0;
		while (true) {
			let accounts = await repository.find({ skip, take: batchSize });
			if (accounts.length === 0) {
				break;
			}

			let batch = accounts.map(x => ({
				id: this.getAccountName(x.url),
				lastProcessingDate: x.lastProcessingDate || null,
				isBusy: false,
				failedCount: 0,
			}));

			console.time(`Batch insert time for ${skip + batch.length} accounts`);

			await graph.execute(async (session) => {
				await session.run(cypherQuery, { accounts: batch });
			});

			console.timeEnd(`Batch insert time for ${skip + batch.length} accounts`);

			console.log('Accounts imported: ' + (skip + batch.length));
			skip += batchSize;

			// cleanup:
			if (skip % gcIteration === 0 && global.gc) {
				console.time('GC')
				global.gc();
				console.timeEnd('GC')
			}
		}
	}

	private async loadFollowers(db: BandDatabase, graph: Graph): Promise<void> {
		const followerRepository = db.dataSource.getRepository(FollowerEntity);
		const accountRepository = db.dataSource.getRepository(AccountEntity);

		const cypherQuery = `
			UNWIND $followers AS follower
			MATCH (f:Account {id: follower.followerId}), (a:Account {id: follower.followedId})
			MERGE (f)-[:FOLLOWS]->(a)
			`;

		let skip = 0;
		while (true) {
			let followers = await followerRepository.find({ skip, take: batchSize });
			if (followers.length === 0) {
				break;
			}

			let followerIds = followers.map(f => f.followerId);
			let followedIds = followers.map(f => f.followedId);
			let accountIds = [...new Set([...followerIds, ...followedIds])];

			let accounts = await accountRepository.findByIds(accountIds);

			let accountMap = new Map(accounts.map(account => [account.id, account]));

			let batch = followers.map(f => {
				const followerAccount = accountMap.get(f.followerId);
				const followedAccount = accountMap.get(f.followedId);

				return {
					followerId: this.getAccountName(followerAccount.url),
					followedId: this.getAccountName(followedAccount.url),
				};
			});


			console.time(`Batch insert time for ${skip + batch.length} followers`);

			await graph.execute(async (session) => {
				await session.run(cypherQuery, { followers: batch });
			});

			console.timeEnd(`Batch insert time for ${skip + batch.length} followers`);

			console.log(`Followers imported: ${(skip + batch.length)}`);
			skip += batchSize;

			// cleanup:
			if (skip % gcIteration === 0 && global.gc) {
				console.time('GC')
				global.gc();
				console.timeEnd('GC')
			}
		}
	}

	private async loadItems(db: BandDatabase, graph: Graph): Promise<void> {
		const repository: Repository<ItemEntity> = db.dataSource.getRepository(ItemEntity);

		let skip = 0;
		while (true) {
			let items = await repository.find({ skip, take: batchSize });
			if (items.length === 0) {
				break;
			}

			let batch = items.map(item => ({
				id: this.getItemId(item.url),
				releaseDate: item.releaseDate || null,
				imageUrl: item.imageUrl || null,
				lastProcessingDate: item.lastProcessingDate || null,
				isBusy: item.isBusy,
				failedCount: item.failedCount
			}));

			console.time(`Batch insert time for ${skip + batch.length} items`);

			await graph.execute(async (session) => {
				await this.createAlbumOrTrackNodes(session, batch);
			});

			console.timeEnd(`Batch insert time for ${skip + batch.length} items`);

			console.log('Items imported: ' + (skip + batch.length));
			skip += batchSize;

			// cleanup:
			if (skip % gcIteration === 0 && global.gc) {
				console.time('GC')
				global.gc();
				console.timeEnd('GC')
			}
		}
	}

	private async createAlbumOrTrackNodes(graphSession: any, items: any[]): Promise<void> {
		const cypherAlbumQuery = `
			UNWIND $items AS item
			MERGE (a:Album {id: item.id})
			SET a.releaseDate = item.releaseDate,
				a.imageUrl = item.imageUrl,
				a.lastProcessingDate = item.lastProcessingDate,
				a.isBusy = item.isBusy,
				a.failedCount = toInteger(item.failedCount)
			`;

		const cypherTrackQuery = `
			UNWIND $items AS item
			MERGE (t:Track {id: item.id})
			SET t.releaseDate = item.releaseDate,
				t.imageUrl = item.imageUrl,
				t.lastProcessingDate = item.lastProcessingDate,
				t.isBusy = item.isBusy,
				t.failedCount = toInteger(item.failedCount)
			`;

		let albums = items.filter(item => item.id.includes('/album/'));
		let tracks = items.filter(item => !item.id.includes('/album/'));

		if (albums.length > 0) {
			console.time('Album insert time');
			await graphSession.run(cypherAlbumQuery, { items: albums });
			console.timeEnd('Album insert time');
		} else {
			console.log('Albums not founded')
		}

		if (tracks.length > 0) {
			console.time('Track insert time');
			await graphSession.run(cypherTrackQuery, { items: tracks });
			console.timeEnd('Track insert time');
		} else {
			console.log('Tracks not founded')
		}
	}

	private async createTrackToAlbumRelations(db: BandDatabase, graph: Graph): Promise<void> {
		const repository: Repository<ItemEntity> = db.dataSource.getRepository(ItemEntity);

		const cypherQuery = `
			UNWIND $items AS item
			MATCH (t:Track {id: item.trackId}), (a:Album {id: item.albumId})
			MERGE (t)-[:BELONGS_TO]->(a)
			`;

		let skip = 0;
		while (true) {
			let items = await repository.find({ skip, take: batchSize });
			if (items.length === 0) {
				break;
			}

			let albumIds = items.filter(item => !isNullOrUndefined(item.albumId)).map(item => item.albumId);
			let uniqueAlbumIds = Array.from(new Set(albumIds));

			let albums = await repository.findByIds(uniqueAlbumIds);
			let albumMap = new Map(albums.map(album => [album.id, album]));

			let batch = [];

			for (const item of items.filter(x => !isNullOrUndefined(x.albumId))) {
				const album = albumMap.get(item.albumId);
				if (!isNullOrUndefined(album)) {
					batch.push({
						trackId: this.getItemId(item.url),
						albumId: this.getItemId(album.url),
					});
				} else {
					console.log('wtf')
				}
			}

			if (batch.length > 0) {
				console.time(`Batch insert time for ${skip + batch.length} relations`);

				// Create the relationships in Neo4j
				await graph.execute(async (session) => {
					await session.run(cypherQuery, { items: batch });
				});

				console.timeEnd(`Batch insert time for ${skip + batch.length} relations`);
			}

			console.log('Items relations imported: ' + (skip + batch.length));
			skip += batchSize;

			// cleanup:
			if (skip % gcIteration === 0 && global.gc) {
				console.time('GC')
				global.gc();
				console.timeEnd('GC')
			}
		}
	}

	private async loadItemToAccountRelations(db: BandDatabase, graph: Graph): Promise<void> {
		const repository = db.dataSource.getRepository(ItemToAccountEntity);
		const accountRepository = db.dataSource.getRepository(AccountEntity);
		const itemRepository = db.dataSource.getRepository(ItemEntity);
		const cypherAlbumQuery = `
			UNWIND $relations AS relation
			MATCH (a:Account {id: relation.accountUrl})
			WITH a, relation
			MATCH (item:Album {id: relation.itemId})
			MERGE (a)-[r:OWNS]->(item)
			SET r.wishlist = relation.wishlist
			`;

		const cypherTrackQuery = `
			UNWIND $relations AS relation
			MATCH (a:Account {id: relation.accountUrl})
			WITH a, relation
			MATCH (item:Track {id: relation.itemId})
			MERGE (a)-[r:OWNS]->(item)
			SET r.wishlist = relation.wishlist
		`;

		let skip = 0;
		while (true) {
			let relations = await repository.find({ skip, take: batchSize });
			if (relations.length === 0) {
				break;
			}

			let accountIds = Array.from(new Set(relations.map(relation => relation.accountId)));
			let itemIds = Array.from(new Set(relations.map(relation => relation.itemId)));

			let accounts = await accountRepository.findByIds(accountIds);
			let items = await itemRepository.findByIds(itemIds);

			let albumBatch = [];
			let trackBatch = [];

			relations.forEach(relation => {
				const account = accounts.find(acc => acc.id === relation.accountId);
				const item = items.find(i => i.id === relation.itemId);

				const isAlbum = item.url.includes('/album/');

				const relationObj = {
					accountUrl: this.getAccountName(account.url),
					itemId: this.getItemId(item.url),
					wishlist: relation.wishlist
				};

				if (isAlbum) {
					albumBatch.push(relationObj);
				} else {
					trackBatch.push(relationObj);
				}
			});

			console.time(`Batch insert time for ${skip + albumBatch.length + trackBatch.length} relations`);

			if (albumBatch.length > 0) {
				await graph.execute(async (session) => {
					await session.run(cypherAlbumQuery, { relations: albumBatch });
				});
			}

			if (trackBatch.length > 0) {
				await graph.execute(async (session) => {
					await session.run(cypherTrackQuery, { relations: trackBatch });
				});
			}

			console.timeEnd(`Batch insert time for ${skip + albumBatch.length + trackBatch.length} relations`);

			console.log('Item to Account relations imported: ' + (skip + albumBatch.length + trackBatch.length));
			skip += batchSize;

			// cleanup:
			if (skip % gcIteration === 0 && global.gc) {
				console.time('GC')
				global.gc();
				console.timeEnd('GC')
			}
		}
	}

	private getItemId(url: string): string {
		return url.replace(/^https?:\/\//, '');
	}

	private getAccountName(url: string): string {
		return url.replace(/^https?:\/\//, '').replace('bandcamp.com/', '');
	}
}
