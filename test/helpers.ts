import { ContextClient, ConnectionError } from "../src/client";
import { ContextFollower, type NoteHost } from "../src/follower";
import { MappingStore } from "../src/mappings";
import type { ContextSnapshot, ContextState } from "../src/types";

export function snapshot(process: string, title: string, path: string | null = null): ContextSnapshot {
	const key = path ? `file:${path.toLowerCase()}` : `window:${process.toLowerCase()}|${title.toUpperCase()}`;
	return { type: path ? "file" : "window", key, path, process, title, pathSource: "None", hwnd: 0, pid: 0 };
}

/** In-memory stand-in for the vault + workspace that records what the plugin did. */
export class FakeHost implements NoteHost {
	files = new Set<string>();
	active: string | null = null;
	opened: string[] = [];
	notices: string[] = [];
	activeNotePath = () => this.active;
	noteExists = (path: string) => this.files.has(path);
	notify = (message: string) => void this.notices.push(message);
	openNote = async (path: string) => {
		this.opened.push(path);
		this.active = path;
	};
}

/** Scripted service: tests set `state`; `failing` simulates a stopped service. */
export class FakeService {
	state: ContextState = { seq: 0, current: null, lastExternal: null, pauseReason: null };
	failing = false;
	set(current: ContextSnapshot | null): void {
		this.state = { seq: this.state.seq + 1, current, lastExternal: current ?? this.state.lastExternal, pauseReason: null };
	}
	client(): ContextClient {
		return new ContextClient(
			async () => (this.failing ? null : { port: 1, token: "t" }),
			async () => {
				if (this.failing) throw new Error("ECONNREFUSED");
				return { status: 200, text: JSON.stringify(this.state) };
			},
		);
	}
}

export function makeFollower(service: FakeService, host: FakeHost, options: { follow?: () => boolean; mappings?: MappingStore } = {}) {
	const mappings = options.mappings ?? new MappingStore();
	const changes: number[] = [];
	const statuses: string[] = [];
	const follower = new ContextFollower(
		service.client(),
		mappings,
		host,
		options.follow ?? (() => true),
		{ onMappingsChanged: () => changes.push(1), onStatus: (s) => statuses.push(s) },
		0,
		async () => {},
	);
	return { follower, mappings, changes, statuses };
}

export { ConnectionError };
