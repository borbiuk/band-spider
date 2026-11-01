import { FastifyInstance } from 'fastify';
import { buildApp } from './app';
import { ConfigStore, JsonFileConfigStore } from './config-store';
import { ForkLauncher, ProcessLauncher } from './process-launcher';
import { Supervisor, SupervisorEntries } from './supervisor';

export const DEFAULT_ADMIN_HOST = '127.0.0.1';
export const DEFAULT_ADMIN_PORT = 4200;

export interface AdminServiceConfig {
	/** The admin listens on this address only. It has no login, so keep it local. */
	host: string;
	port: number;
	configStore: ConfigStore;
	launcher: ProcessLauncher;
	entries: SupervisorEntries;
}

export interface AdminService {
	url: string;
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
	const app = buildApp({ supervisor, configStore: config.configStore });
	const url = await app.listen({ host: config.host, port: config.port });

	let stopping: Promise<void> | undefined;
	return {
		url,
		supervisor,
		app,
		stop: () => stopping ??= supervisor.shutdown().finally(() => app.close()),
	};
};
