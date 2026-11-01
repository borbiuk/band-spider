import { ChildHandle, ExitInfo, LaunchSpec, OutputStream, ProcessLauncher } from '../process-launcher';

/** A child that a test drives by hand. */
export class FakeChild implements ChildHandle {
	readonly pid = 1000 + Math.floor(Math.random() * 1000);
	readonly sent: unknown[] = [];
	readonly signals: string[] = [];
	private messageListeners: Array<(message: unknown) => void> = [];
	private outputListeners: Array<(stream: OutputStream, text: string) => void> = [];
	private exitListeners: Array<(info: ExitInfo) => void> = [];

	/** What the child does when it is asked to stop. A test can set it to do nothing. */
	onStopRequest: () => void = () => this.exit(0);

	constructor(readonly spec: LaunchSpec) {
	}

	send(message: unknown): void {
		this.sent.push(message);
		if ((message as { type?: string }).type === 'stop') {
			this.onStopRequest();
		}
	}

	kill(signal: 'SIGTERM' | 'SIGKILL'): void {
		this.signals.push(signal);
		if (signal === 'SIGKILL') {
			this.exit(null, 'SIGKILL');
		} else {
			this.onStopRequest();
		}
	}

	onMessage(listener: (message: unknown) => void): void {
		this.messageListeners.push(listener);
	}

	onOutput(listener: (stream: OutputStream, text: string) => void): void {
		this.outputListeners.push(listener);
	}

	onExit(listener: (info: ExitInfo) => void): void {
		this.exitListeners.push(listener);
	}

	emit(message: unknown): void {
		this.messageListeners.forEach(listener => listener(message));
	}

	print(text: string, stream: OutputStream = 'stdout'): void {
		this.outputListeners.forEach(listener => listener(stream, text));
	}

	exit(code: number | null, signal: string | null = null): void {
		this.exitListeners.forEach(listener => listener({ code, signal }));
	}
}

export class FakeLauncher implements ProcessLauncher {
	readonly children: FakeChild[] = [];
	/** Called for each new child, for example to make a DB service that is ready at once. */
	onLaunch: (child: FakeChild) => void = () => undefined;

	launch(spec: LaunchSpec): ChildHandle {
		const child = new FakeChild(spec);
		this.children.push(child);
		// after the caller has set its listeners
		queueMicrotask(() => this.onLaunch(child));
		return child;
	}

	/** The children started from this script. */
	of(entry: string): FakeChild[] {
		return this.children.filter(child => child.spec.entry === entry);
	}
}

export const DB_ENTRY = 'db-entry.js';
export const CRAWLER_ENTRY = 'crawler-entry.js';

/** A launcher where a DB service says ready at once. */
export const readyDbLauncher = (url = 'http://127.0.0.1:4100'): FakeLauncher => {
	const launcher = new FakeLauncher();
	launcher.onLaunch = child => {
		if (child.spec.entry === DB_ENTRY) {
			child.emit({ type: 'ready', url });
		}
	};
	return launcher;
};
