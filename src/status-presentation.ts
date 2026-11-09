import type { ConnectionStatus, ContextState } from "./types";
import { contextAccess } from "./context-policy";
import { compactStatus } from "./presentation";

// Earlier same-companion traces show short same-key gaps of 297–1454 ms and
// sustained gaps of 1.9–11 s. Three existing 500 ms observation periods cover
// the short gaps without hiding sustained failures. This never gates actions.
export const STATUS_GRACE_MS = 1500;

export class StatusPresentation {
    private readyKey: string | null = null;
    private unavailableSince: number | null = null;
    private lastSeq = -1;

    read(status: ConnectionStatus, state: ContextState | null, following: boolean, mapped: boolean,
        showUnmappedHint = true, now = performance.now()): { text: string; refreshAfterMs?: number } {
        const access = contextAccess(status, state);
        const raw = compactStatus(status, state, following, mapped, undefined, showUnmappedHint);
        if (state && state.seq < this.lastSeq) this.reset();
        this.lastSeq = state?.seq ?? -1;
        if (access.kind === "ready") {
            this.readyKey = access.target?.key ?? null;
            this.unavailableSince = null;
            return { text: raw };
        }
        if ((access.kind === "privacy-unknown" || access.kind === "identity-unavailable") &&
            this.readyKey !== null && access.accepted?.key === this.readyKey) {
            this.unavailableSince ??= now;
            const remaining = STATUS_GRACE_MS - (now - this.unavailableSince);
            if (remaining > 0) return {
                text: !following ? "ClingNote: Paused" : mapped ? "ClingNote: Following" :
                    showUnmappedHint ? "ClingNote: No note attached" : "ClingNote: Ready",
                refreshAfterMs: remaining,
            };
            return { text: raw };
        }
        this.reset(); // Private, disconnect, none, different key or no prior confirmed target: immediate.
        return { text: raw };
    }

    private reset(): void { this.readyKey = null; this.unavailableSince = null; this.lastSeq = -1; }
}
