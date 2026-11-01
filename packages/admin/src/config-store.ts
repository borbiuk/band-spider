import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AdminConfig, adminConfigSchema, defaultAdminConfig } from './config';

/** Where the admin settings live. A variation point: a file today, maybe something else later. */
export interface ConfigStore {
	load(): Promise<AdminConfig>;
	save(config: AdminConfig): Promise<void>;
}

/** The config is never inside the repo, it can hold proxy passwords. */
export const defaultConfigPath = (env: NodeJS.ProcessEnv = process.env): string =>
	env.ADMIN_CONFIG_PATH || path.join(os.homedir(), '.band-spider', 'admin-config.json');

export class JsonFileConfigStore implements ConfigStore {
	constructor(private readonly file: string = defaultConfigPath()) {
	}

	async load(): Promise<AdminConfig> {
		let text: string;
		try {
			text = await fs.promises.readFile(this.file, 'utf8');
		} catch (error) {
			// no file yet means the defaults
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				return defaultAdminConfig();
			}
			throw error;
		}
		const result = adminConfigSchema.safeParse(JSON.parse(text));
		if (!result.success) {
			const issues = result.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`);
			throw new Error(`Admin config ${this.file} is invalid: ${issues.join('; ')}`);
		}
		return result.data;
	}

	async save(config: AdminConfig): Promise<void> {
		await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
		// write to a temp file and rename, so a crash never leaves half a file
		const temp = `${this.file}.${process.pid}.tmp`;
		await fs.promises.writeFile(temp, JSON.stringify(config, null, '\t'), { mode: 0o600 });
		await fs.promises.rename(temp, this.file);
	}
}
