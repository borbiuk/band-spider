import { fork } from 'node:child_process';

export interface LaunchSpec {
	/** The script to run. */
	entry: string;
	args?: string[];
	/** Added to the environment of this process. A key with undefined removes it. */
	env?: Record<string, string | undefined>;
}

export interface ExitInfo {
	code: number | null;
	signal: string | null;
}

export type OutputStream = 'stdout' | 'stderr';

/** A running child. The listeners are set right after launch. */
export interface ChildHandle {
	readonly pid: number | undefined;
	send(message: unknown): void;
	kill(signal: 'SIGTERM' | 'SIGKILL'): void;
	onMessage(listener: (message: unknown) => void): void;
	onOutput(listener: (stream: OutputStream, text: string) => void): void;
	/** Called once, also when the child could not start. */
	onExit(listener: (info: ExitInfo) => void): void;
}

/** Starts child processes. A variation point: child_process.fork today, a fake in tests. */
export interface ProcessLauncher {
	launch(spec: LaunchSpec): ChildHandle;
}

export class ForkLauncher implements ProcessLauncher {
	launch(spec: LaunchSpec): ChildHandle {
		const env: Record<string, string> = {};
		for (const [key, value] of Object.entries({ ...process.env, ...spec.env })) {
			if (value !== undefined) {
				env[key] = value;
			}
		}
		const child = fork(spec.entry, spec.args ?? [], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });

		const exitListeners: Array<(info: ExitInfo) => void> = [];
		let exited = false;
		const exit = (info: ExitInfo): void => {
			if (!exited) {
				exited = true;
				exitListeners.forEach(listener => listener(info));
			}
		};
		child.on('exit', (code, signal) => exit({ code, signal }));
		// a spawn error has no exit event
		child.on('error', () => exit({ code: null, signal: null }));

		return {
			pid: child.pid,
			send: message => {
				if (child.connected) {
					child.send(message as never);
				}
			},
			kill: signal => {
				child.kill(signal);
			},
			onMessage: listener => {
				child.on('message', listener);
			},
			onOutput: listener => {
				child.stdout?.setEncoding('utf8').on('data', text => listener('stdout', text));
				child.stderr?.setEncoding('utf8').on('data', text => listener('stderr', text));
			},
			onExit: listener => {
				exitListeners.push(listener);
			},
		};
	}
}
