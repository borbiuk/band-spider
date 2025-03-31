import neo4j from 'neo4j-driver'
import { isNullOrUndefined } from '../common/utils';

export class Graph {
	private static instance: Graph;

	public readonly driver: any;

	private constructor() {
		const uri = 'neo4j://localhost:7687';
		const user = 'neo4j';
		const password = 'secretgraph';

		this.driver = neo4j.driver(uri, neo4j.auth.basic(user, password))
	}

	public static async initialize(): Promise<Graph> {
		if (isNullOrUndefined(Graph.instance)) {
			Graph.instance = new Graph();
		}

		return Graph.instance;
	}

	public async execute(sessionHandler: (s: any) => Promise<void>): Promise<void> {
		const session = this.driver.session();
		try {
			await sessionHandler(session);
		}
		catch (error) {
			console.error(error);
			throw error;
		}
		finally {
			if (!isNullOrUndefined(session)) {
				await session.close();
			}
		}
	}
}
