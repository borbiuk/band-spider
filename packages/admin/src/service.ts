import { AddressInfo } from 'node:net';
import { FastifyInstance } from 'fastify';
import { buildApp } from './app';
import { ConfigStore, JsonFileConfigStore } from './config-store';
import { generateToken, sessionUrl } from './security';
import { ForkLauncher, ProcessLauncher } from './process-launcher';
import { Supervisor, SupervisorEntries } from './supervisor';

export const DEFAULT_ADMIN_HOST = '127.0.0.1';
export const DEFAULT_ADMIN_PORT = 4200;

export interface AdminServiceConfig {
	/** The admin listens on this address only. Other sites are blocked by the Host and Origin checks and by the session token. */
	host: string;
	port: number;
	configStore: ConfigStore;
	launcher: ProcessLauncher;
	entries: SupervisorEntries;
	/** The session token. A random one is made at start when it is not given. */
	token?: string;
}

export interface AdminService {
	url: string;
	/** The URL to open in the browser, it has the session token. */
	sessionUrl: string;
	token: string;
	supervisor: Supervisor;
	app: FastifyInstance;
	/** Stops the children, then the server. It can be called twice. */
	stop(): Promise<void>;
}

/** Reads ADMIN_HOST, ADMIN_PORT and ADMIN_CONFIG_PATH. The processes are the built db-service and crawler packages. */
export const readAdminConfig = (env: NodeJS.ProcessEnv = process.env): AdminServiceConfig => {
	const port = env.ADMIN_PORT === undefined ? DEFAULT_ADMIN_PORT : Number(env.ADMIN_PORT);
	if (!Number.isInteger(port) || port < 0 || port > 65535) {
		throw new Error(`ADMIN_PORT is invalid: ${env.ADMIN_PORT}`);
	}
	return {
		host: env.ADMIN_HOST ?? DEFAULT_ADMIN_HOST,
		port,
		configStore: new JsonFileConfigStore(env.ADMIN_CONFIG_PATH || undefined),
		launcher: new ForkLauncher(),
		entries: {
			dbService: require.resolve('@band-spider/db-service'),
			crawler: require.resolve('@band-spider/crawler'),
		},
	};
};

/** The composition root of the admin process. */
export const startAdmin = async (config: AdminServiceConfig): Promise<AdminService> => {
	const supervisor = new Supervisor({
		launcher: config.launcher,
		configStore: config.configStore,
		entries: config.entries,
	});
	const token = config.token ?? generateToken();
	let port = config.port;
	const app = buildApp({ supervisor, configStore: config.configStore, security: { token, port: () => port } });
	const url = await app.listen({ host: config.host, port: config.port });
	// With port 0 the real port is known only now
	port = (app.server.address() as AddressInfo).port;

	let stopping: Promise<void> | undefined;
	return {
		url,
		sessionUrl: sessionUrl(url, token),
		token,
		supervisor,
		app,
		stop: () => stopping ??= supervisor.shutdown().finally(() => app.close()),
	};
};
