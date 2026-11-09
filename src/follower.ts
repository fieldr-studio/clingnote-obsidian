import { ConnectionError, type ContextClient } from "./client";
import { traceContext } from "./diagnostics";
import { navigationFor } from "./navigation";
import { attachmentTarget, contextAccess, savedGroupEdits } from "./context-policy";
import type { MappingStore } from "./mappings";
import type { ConnectionStatus, ContextSnapshot, ContextState, GroupHeader } from "./types";

/** Display-only changes never need a live context; relationship changes wait only while browser privacy is unknown or private. */
export const DISPLAY_CHANGES: ReadonlyArray<GroupChange["kind"]> = ["header", "icon", "restore", "reorder"];
export type GroupChange = { kind: "main" | "remove"; path: string } | { kind: "drop"; path: string; onto: string } |
    { kind: "reorder"; order: string[] } | { kind: "header"; header: GroupHeader } | { kind: "detach" } |
    { kind: "add"; path: string } | { kind: "icon"; icon: string | null } | { kind: "restore" } |
    { kind: "insert"; path: string; before?: string } | { kind: "moveTo"; path: string; to: string };

/** Everything the follower needs from Obsidian. Implemented over the real workspace in main.ts. */
export interface NoteHost {
	activeNotePath(): string | null;
	noteExists(path: string): boolean;
	/** Show the note (reuse its tab if open) WITHOUT taking keyboard focus from the Windows app. */
	openNote(path: string): Promise<void>;
	notify(message: string): void;
}

export interface FollowerHooks {
	onStatus?(status: ConnectionStatus): void;
	onMappingsChanged?(): void;
	onContext?(state: ContextState): void;
	/** True while the license does not allow automatic following. Attachments, the sidebar and manual navigation are unaffected. */
	limited?(): boolean;
}

export interface ActionResult {
	ok: boolean;
	message: string;
}

/** One automatic-following decision. Metadata only: never a raw key, URL, title or path. */
export interface FollowDecision { at: number; seq: number; availability: string; keyKind: string; outcome: string }
const MAX_DECISIONS = 40;

export function labelOf(snapshot: ContextSnapshot): string {
	if (snapshot.path) return snapshot.path.split(/[\\/]/).pop() || snapshot.path;
	return snapshot.title || snapshot.process;
}

/**
 * Turns Windows context changes into "open the attached note". It never creates, edits, moves or deletes
 * notes; an unmapped context, a missing note or a lost connection all result in doing nothing.
 */
export class ContextFollower {
	status: ConnectionStatus = "connecting";
	connectionIssue: "incompatible" | "missing" | "installed" | "interrupted" | null = null;
	lastState: ContextState | null = null;
	private seq = -1;
	private lastKey: string | null = null;
	private stopped = false;
	private generation = 0;
	private readonly warnedOpen = new Set<string>();
	private readonly warnedMissing = new Set<string>();
	/** Why recent contexts did or did not open a note; shown by "Copy following diagnostics". */
	readonly decisions: FollowDecision[] = [];
	/** Connection and availability transitions with times, so a long "unavailable" stretch shows its reason and duration. */
	private readonly timeline: Array<{ at: number; what: string }> = [];
	private lastAvailability = "";
	private mark(what: string): void {
		this.timeline.push({ at: Date.now(), what });
		if (this.timeline.length > 60) this.timeline.shift();
	}

	constructor(
		private readonly client: ContextClient,
		readonly mappings: MappingStore,
		private readonly host: NoteHost,
		private readonly followEnabled: () => boolean,
		private readonly hooks: FollowerHooks = {},
		private readonly pollTimeoutMs = 25_000,
		private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	) {}

	/** One poll iteration. Returns false when the service could not be reached (status becomes disconnected). */
	async step(): Promise<boolean> {
		const generation = this.generation;
		try {
			const state = this.seq < 0 ? await this.client.getState() : await this.client.poll(this.seq, this.pollTimeoutMs);
            if (this.stopped || generation !== this.generation) { traceContext("discard-generation", state); return true; }
            if (this.lastState && state.seq < this.lastState.seq) { traceContext("discard-older-seq", state); return true; }
			this.connectionIssue = null;
			this.setStatus("connected");
			this.seq = state.seq;
			await this.apply(state);
			return true;
		} catch (error) {
			if (this.stopped || generation !== this.generation) return true;
			if (!(error instanceof ConnectionError)) throw error;
			// "interrupted" needs evidence: we were connected a moment ago. A stale endpoint file alone proves nothing.
			const before = this.connectionIssue;
			this.connectionIssue = error.message.startsWith("Incompatible") ? "incompatible" : error.reason ?? (this.status === "connected" ? "interrupted" : this.connectionIssue === "interrupted" ? "interrupted" : null);
			this.disconnected();
			if (this.connectionIssue !== before) this.hooks.onStatus?.(this.status); // same status, new reason: refresh the connection notice
			return false;
		}
	}

	/** Runs until <see cref="stop"/>; reconnects with a 1s..5s backoff. */
	async run(): Promise<void> {
		this.stopped = false;
		let delay = 1000;
		while (!this.stopped) {
			const ok = await this.step();
			if (ok) delay = 1000;
			else if (!this.stopped) {
				await this.sleep(delay);
				delay = Math.min(delay * 2, 5000);
			}
		}
	}

	stop(): void {
		this.stopped = true;
		this.generation++;
		this.client.invalidate();
	}

	async reconnect(): Promise<void> {
		this.generation++;
		this.client.invalidate();
		this.seq = -1;
		this.lastKey = null;
		this.lastState = null;
		this.setStatus("connecting");
		await this.step();
	}

	/** Re-evaluates the current context (e.g. after following is switched back on). */
	async refresh(): Promise<void> {
		this.generation++; // an older in-flight poll must not undo the freshly fetched privacy state
		this.lastKey = null;
		this.seq = -1;
		await this.step(); // fetch fresh state: cached state may predate a privacy transition
	}

	private setStatus(status: ConnectionStatus): void {
		if (this.status === status) return;
		this.status = status;
		this.mark(`connection:${status}`);
		this.hooks.onStatus?.(status);
	}

	private disconnected(): void {
		this.generation++; // invalidate other in-flight results from the previous connection
		this.seq = -1;
		this.lastKey = null;
		this.lastState = null;
		this.setStatus("disconnected");
	}

	private note(state: ContextState, access: ReturnType<typeof contextAccess>, outcome: string): void {
		const key = access.target?.key ?? access.accepted?.key ?? "";
		const keyKind = !key ? "none" : key.startsWith("url:") ? "url" : key.startsWith("file-id:") ? "file" : key.startsWith("window:") ? "window" : "other";
		this.decisions.push({ at: Date.now(), seq: state.seq, availability: access.kind, keyKind, outcome });
		if (this.decisions.length > MAX_DECISIONS) this.decisions.shift();
	}

	diagnosticsText(): string {
		const lines = this.decisions.map(d => `${new Date(d.at).toISOString()} seq=${d.seq} availability=${d.availability} key=${d.keyKind} -> ${d.outcome}`);
		const last = this.timeline[this.timeline.length - 1];
		const since = last ? `${last.what} for ${Math.round((Date.now() - last.at) / 1000)}s` : "no observations yet";
		const timeline = this.timeline.map(t => `${new Date(t.at).toISOString()} ${t.what}`);
		return [`ClingNote following diagnostics (${lines.length} recent decisions; no URLs, titles or paths)`, `status=${this.status}`, `now: ${since}`,
			"timeline (connection and availability changes):", ...timeline, "decisions:", ...lines].join("\n");
	}

	private async apply(state: ContextState): Promise<void> {
		this.lastState = state;
        traceContext("apply", state);
		this.hooks.onContext?.(state);
        const access = contextAccess(this.status, state);
        if (access.kind !== this.lastAvailability) { this.lastAvailability = access.kind; this.mark(`availability:${access.kind}`); }
        if (access.kind === "none") this.lastKey = null;
        if (!access.target) { this.note(state, access, `waiting: ${access.kind}`); return; } // uncertainty/private do not reset logical-transition dedupe
		// Refresh only reverse-navigation metadata after a proven identity is observed at a new path.
        // No history event, identity change, or additional note open is caused by this metadata.
        const observed = access.target;
        const saved = observed && this.mappings.get(observed.key);
        if (observed && saved && (!saved.navigation || (saved.navigation.kind !== "page" && saved.navigation.path !== observed.path))) {
            const navigation = navigationFor(observed);
            if (navigation && this.mappings.updateNavigation(observed.key, navigation)) this.hooks.onMappingsChanged?.();
        }
		if (!this.followEnabled()) { this.note(state, access, "following paused"); return; }
		if (this.hooks.limited?.()) { this.note(state, access, "license required"); return; }
		const current = access.target;
		if (!current) { this.lastKey = null; return; }
		if (current.key === this.lastKey) { this.note(state, access, "same context as last open"); return; }
		this.lastKey = current.key;

		const mapping = this.mappings.get(current.key);
        traceContext("mapping-lookup", state, { mappingKey: current.key, notePath: mapping?.notePath });
		if (!mapping) { this.note(state, access, "no note attached"); return; } // no attachment: do nothing
		if (!mapping.notePath.toLowerCase().endsWith(".md") || !this.host.noteExists(mapping.notePath)) {
			this.note(state, access, "attached note missing");
			if (!this.warnedMissing.has(mapping.notePath)) {
				this.warnedMissing.add(mapping.notePath);
				this.host.notify(`ClingNote: the note attached to "${mapping.label}" no longer exists (${mapping.notePath}).`);
			}
			return;
		}
		this.warnedMissing.delete(mapping.notePath);
		if (this.host.activeNotePath() === mapping.notePath) { this.note(state, access, "note already active"); return; }
		try {
            traceContext("note-open-start", state, { mappingKey: current.key, notePath: mapping.notePath });
			await this.host.openNote(mapping.notePath);
			this.note(state, access, "opened attached note");
            traceContext("note-open-complete-original-state", state, { mappingKey: current.key, notePath: mapping.notePath });
            traceContext("note-open-complete-latest-state", this.lastState);
			this.warnedOpen.delete(mapping.notePath);
		} catch {
			this.lastKey = null; // retry on a subsequent poll; keep the loop alive
			this.note(state, access, "open failed (will retry)");
			if (!this.warnedOpen.has(mapping.notePath)) {
				this.warnedOpen.add(mapping.notePath);
				this.host.notify(`ClingNote: could not open ${mapping.notePath}. Following will retry.`);
			}
		}
	}

	/** The context a command should act on: the foreground work, else the last external work (Obsidian itself is ignored). */
	private async resolveTarget(): Promise<ContextSnapshot | null> {
		const generation = this.generation;
		const state = await this.client.getState();
		if (this.stopped || generation !== this.generation) throw new ConnectionError("Context changed during command.");
		const latest = this.lastState && this.lastState.seq > state.seq ? this.lastState : state;
		this.connectionIssue = null;
		this.setStatus("connected");
		this.lastState = latest;
		this.hooks.onContext?.(latest);
		return contextAccess(this.status, latest).target;
	}

	async attachCurrentNote(notePath = this.host.activeNotePath(), related = false): Promise<ActionResult> {
		if (!notePath) return { ok: false, message: "Open a note first, then attach it." };
		if (!notePath.toLowerCase().endsWith(".md")) return { ok: false, message: "Open a Markdown (.md) note first." };
		if (!this.host.noteExists(notePath)) return { ok: false, message: "This note no longer exists. Open a Markdown note first." };
		let target: ContextSnapshot | null;
		try {
			target = await this.resolveTarget();
		} catch (error) {
			if (error instanceof ConnectionError) { this.disconnected(); return { ok: false, message: "The ClingNote context service is not running." }; }
			throw error;
		}
		if (!target || !attachmentTarget(this.status, this.lastState, notePath)) return { ok: false, message: "No safe context available. Switch to the target and try again." };
		const label = labelOf(target);
        if (related) {
            const added = this.mappings.addNote(target.key, notePath, label, navigationFor(target));
            if (added) { this.lastKey = target.key; this.hooks.onMappingsChanged?.(); }
            return { ok: added, message: added ? "Note attached." : "This note is already attached." };
        }
		const replaced = this.mappings.attach(target.key, notePath, label, navigationFor(target));
		this.lastKey = target.key; // already looking at the note: do not jump on the next poll
		this.hooks.onMappingsChanged?.();
		const kind = target.type === "file" ? "file" : "window (no file path available)";
		return {
			ok: true,
			message: replaced
				? `Main note is now ${notePath}. ${replaced.notePath} stays attached.`
				: `Attached "${notePath}" to ${kind} "${label}".`,
		};
	}

    async addCurrentNote(notePath = this.host.activeNotePath()): Promise<ActionResult> { return this.attachCurrentNote(notePath, true); }
    async changeGroup(key: string, change: GroupChange): Promise<ActionResult> {
        if (!DISPLAY_CHANGES.includes(change.kind)) {
            const policy = await this.relationshipPolicy();
            if (!policy.relationships) return { ok: false, message: policy.reason };
        }
        if (!this.mappings.group(key)) return { ok: false, message: "That context no longer exists." };
        if ((change.kind === "main" || change.kind === "drop" || change.kind === "add" || change.kind === "insert" || change.kind === "moveTo") && !this.host.noteExists(change.path))
            return { ok: false, message: "The selected note is missing." };
        let changed = false;
        switch (change.kind) {
            case "main": changed = this.mappings.makeMain(key, change.path); break;
            case "remove": changed = this.mappings.removeNote(key, change.path); break;
            case "drop": changed = this.mappings.dropNote(key, change.path, change.onto); break;
            case "reorder": changed = this.mappings.reorderRelated(key, change.order); break;
            case "header": changed = this.mappings.setHeader(key, change.header); break;
            case "detach": changed = this.mappings.detach(key); break;
            case "add": { const group = this.mappings.group(key); changed = !!group && this.mappings.addNote(key, change.path, group.label); break; }
            case "icon": changed = this.mappings.setIcon(key, change.icon); break;
            case "restore": changed = this.mappings.restoreAppearance(key); break;
            case "insert": changed = this.mappings.insertNote(key, change.path, change.before); break;
            case "moveTo": changed = this.mappings.moveNote(key, change.to, change.path); break;
        }
        if (changed) this.hooks.onMappingsChanged?.();
        return { ok: changed, message: changed ? "Context updated. Note files were not changed." : "No attachment change was needed or the selection changed." };
    }
    async removeCurrentNote(notePath = this.host.activeNotePath()): Promise<ActionResult> {
        let target: ContextSnapshot | null;
        try { target = await this.resolveTarget(); } catch { return { ok: false, message: "Companion unavailable." }; }
        if (!target || !notePath) return { ok: false, message: "No safe context or current note." };
        const changed = this.mappings.removeNote(target.key, notePath);
        if (changed) this.hooks.onMappingsChanged?.();
        return { ok: changed, message: changed ? "Note detached. Note files were not changed." : "This note is not attached to the current context." };
    }

	async detachCurrentContext(): Promise<ActionResult> {
		let target: ContextSnapshot | null;
		try {
			target = await this.resolveTarget();
		} catch (error) {
			if (error instanceof ConnectionError) { this.disconnected(); return { ok: false, message: "The ClingNote context service is not running." }; }
			throw error;
		}
		if (!target) return { ok: false, message: this.lastState?.pauseReason ? "Paused: private browsing (or privacy cannot be verified)." : "No safe context available." };
		const label = labelOf(target);
		if (!this.mappings.detach(target.key)) return { ok: false, message: `Nothing is attached to "${label}".` };
		this.hooks.onMappingsChanged?.();
		return { ok: true, message: `Detached the note from "${label}".` };
	}

	/** Explicit user action; independent of automatic following, but never of privacy. */
	async openCurrentNote(): Promise<ActionResult> {
		let target: ContextSnapshot | null;
		try { target = await this.resolveTarget(); }
		catch (error) {
			if (error instanceof ConnectionError) { this.disconnected(); return { ok: false, message: "The ClingNote companion isn't running. Retry connection or open settings." }; }
			throw error;
		}
		if (!target) return { ok: false, message: this.lastState?.pauseReason ? "Paused: private browsing or privacy could not be verified." : "No safe context available." };
		const mapping = this.mappings.get(target.key);
		if (!mapping) return { ok: false, message: "No note is attached to this context." };
		return this.openSavedNote(mapping.notePath);
	}

	async openSavedNote(path: string): Promise<ActionResult> {
		if (!path.toLowerCase().endsWith(".md") || !this.host.noteExists(path))
			return { ok: false, message: "The attached Markdown note is missing. Detach it or choose another note." };
		try { await this.host.openNote(path); return { ok: true, message: "Opened attached note." }; }
		catch { return { ok: false, message: "Could not open the attached note. Check vault access." }; }
	}

    /** Fresh privacy view for relationship edits. A stopped companion has no live context to leak, so it does not block. */
    private async relationshipPolicy(): Promise<ReturnType<typeof savedGroupEdits>> {
        try {
            const generation = this.generation;
            const state = await this.client.getState();
            if (this.stopped || generation !== this.generation) return savedGroupEdits(this.status, this.lastState);
            const latest = this.lastState && this.lastState.seq > state.seq ? this.lastState : state;
            this.connectionIssue = null; this.setStatus("connected"); this.lastState = latest; this.hooks.onContext?.(latest);
            return savedGroupEdits("connected", latest);
        } catch (error) {
            if (!(error instanceof ConnectionError)) throw error;
            this.disconnected();
            return savedGroupEdits("disconnected", null);
        }
    }

    async confirmNormalContext(): Promise<boolean> {
        try { return !!await this.resolveTarget(); }
        catch { this.disconnected(); return false; }
    }

	/** Short text for the status bar. */
	statusText(): string {
		if (this.status === "disconnected") return "ClingNote: service not running";
		if (this.status === "connecting") return "ClingNote: connecting...";
        const access = contextAccess(this.status, this.lastState);
        if (access.kind === "private") return "ClingNote: paused: private browsing";
        if (access.kind === "privacy-unknown" || access.kind === "identity-unavailable") return "ClingNote: Context unavailable";
		if (!this.followEnabled()) return "ClingNote: paused";
		if (this.hooks.limited?.()) return "ClingNote: following needs a trial or Pro";
		const current = access.target;
		if (!current) return "ClingNote: no file";
		const mapping = this.mappings.get(current.key);
        traceContext("status-format", this.lastState, { statusKey: current.key, notePath: mapping?.notePath });
		return mapping ? `ClingNote: ${labelOf(current)} -> ${mapping.notePath.split("/").pop()}` : `ClingNote: ${labelOf(current)} (no note)`;
	}
}
