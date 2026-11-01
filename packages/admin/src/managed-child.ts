import { conflict } from './errors';
import { ChildHandle, ExitInfo, LaunchSpec, ProcessLauncher } from './process-launcher';
import { LogRingBuffer } from './ring-buffer';

export type ChildState = 'stopped' | 'starting' | 'running' | 'stopping' | 'failed';

export interface CrawlerCounts {
	claimed: number;
	saved: number;
	failed: number;
	rateLimited: number;
	notFound: number;
}

export interface ChildStatus {
	state: ChildState;
	pid?: number;
	/** The DB service URL from its ready message. */
	url?: string;
	counts?: CrawlerCounts;
	error?: string;
}

/** How to ask a child to stop: an IPC message or a signal. */
export type StopRequest = { message: unknown } | { signal: 'SIGTERM' };

/**
 * One child process and its state. The state comes from IPC messages and from the exit event.
 * The supervisor reads the messages of its kind of child and calls markRunning and markFinished.
 */
export class ManagedChild {
	readonly logs: LogRingBuffer;
	/** Called when the state changes or the supervisor calls notify. */
	onChange?: () => void;
	/** Called with each chunk of output. */
	onOutput?: (text: string) => void;
	error?: string;
	url?: string;
	counts?: CrawlerCounts;
	private currentState: ChildState = 'stopped';
	private handle?: ChildHandle;
	private exited = false;
	/** The child said it has finished its work. */
	private finished = false;
	private exitWaiters: Array<() => void> = [];
	private runningWaiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];

	constructor(
		private readonly launcher: ProcessLauncher,
		private readonly stopRequest: StopRequest,
		private readonly stopTimeoutMs: number,
		logLines: number,
	) {
		this.logs = new LogRingBuffer(logLines);
	}

	get state(): ChildState {
		return this.currentState;
	}

	set state(value: ChildState) {
		if (value !== this.currentState) {
			this.currentState = value;
			this.onChange?.();
		}
	}

	/** Tells the listener that something else changed, for example the counts. */
	notify(): void {
		this.onChange?.();
	}

	get isActive(): boolean {
		return this.state === 'starting' || this.state === 'running' || this.state === 'stopping';
	}

	status(): ChildStatus {
		return {
			state: this.state,
			pid: this.isActive ? this.handle?.pid : undefined,
			url: this.url,
			counts: this.counts,
			error: this.error,
		};
	}

	/** Marks the child as starting before the process exists, for example while it waits for the DB service. */
	begin(): void {
		if (this.isActive) {
			throw conflict(`Already ${this.state}`);
		}
		this.state = 'starting';
		this.error = undefined;
		this.url = undefined;
		this.counts = undefined;
		this.finished = false;
		this.exited = false;
		this.handle = undefined;
	}

	/** Gives up a start that did not launch. */
	fail(message: string): void {
		this.error = message;
		this.state = 'failed';
		this.notify();
		this.settleRunning(new Error(message));
	}

	launch(spec: LaunchSpec, onMessage: (child: ManagedChild, message: unknown) => void): void {
		const handle = this.launcher.launch(spec);
		this.handle = handle;
		handle.onOutput((_stream, text) => {
			this.logs.append(text);
			this.onOutput?.(text);
		});
		handle.onMessage(message => onMessage(this, message));
		handle.onExit(info => this.onExit(handle, info));
	}

	send(message: unknown): void {
		this.handle?.send(message);
	}

	markRunning(): void {
		if (this.state === 'starting') {
			this.state = 'running';
			this.settleRunning();
		}
	}

	/** The child reported that it finished. An error makes the end a failure. */
	markFinished(error?: string): void {
		this.finished = true;
		if (error) {
			this.error = error;
		}
		this.notify();
	}

	/** Resolves when the child is running, rejects when it ends first. */
	whenRunning(): Promise<void> {
		if (this.state === 'running') {
			return Promise.resolve();
		}
		if (this.state !== 'starting') {
			return Promise.reject(new Error(this.error ?? `Not started (${this.state})`));
		}
		return new Promise((resolve, reject) => this.runningWaiters.push({ resolve, reject }));
	}

	/** Asks the child to stop and waits for its exit. A child that does not stop in time is killed. */
	async stop(): Promise<void> {
		if (this.state === 'stopping') {
			return new Promise(resolve => this.exitWaiters.push(resolve));
		}
		if (!this.isActive) {
			return;
		}
		const handle = this.handle;
		if (!handle || this.exited) {
			// not launched yet
			this.state = 'stopped';
			this.settleRunning(new Error('Stopped'));
			return;
		}
		this.state = 'stopping';
		const done = new Promise<void>(resolve => this.exitWaiters.push(resolve));
		const timer = setTimeout(() => handle.kill('SIGKILL'), this.stopTimeoutMs);
		if ('message' in this.stopRequest) {
			handle.send(this.stopRequest.message);
		} else {
			handle.kill(this.stopRequest.signal);
		}
		await done;
		clearTimeout(timer);
	}

	private onExit(handle: ChildHandle, info: ExitInfo): void {
		if (handle !== this.handle) {
			return;
		}
		this.exited = true;
		if (this.error) {
			this.state = 'failed';
		} else if (this.state === 'stopping' || this.finished || info.code === 0) {
			this.state = 'stopped';
		} else {
			this.state = 'failed';
			this.error = info.signal ? `Killed by ${info.signal}` : `Exited with code ${info.code}`;
		}
		this.notify();
		this.settleRunning(new Error(this.error ?? 'Exited before it was ready'));
		const waiters = this.exitWaiters;
		this.exitWaiters = [];
		waiters.forEach(resolve => resolve());
	}

	private settleRunning(error?: Error): void {
		const waiters = this.runningWaiters;
		this.runningWaiters = [];
		waiters.forEach(waiter => error ? waiter.reject(error) : waiter.resolve());
	}
}
