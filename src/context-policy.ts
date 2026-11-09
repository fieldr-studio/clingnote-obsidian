import type { ConnectionStatus, ContextSnapshot, ContextState } from "./types";
import { notePath as validNotePath } from "./validation";

export type ContextAccess = {
    kind: "ready" | "none" | "private" | "privacy-unknown" | "identity-unavailable" | "connecting" | "disconnected";
    accepted: ContextSnapshot | null;
    target: ContextSnapshot | null;
};

/** Single interpretation shared by following, commands and every presentation surface. */
export function contextAccess(status: ConnectionStatus, state: ContextState | null): ContextAccess {
    if (status !== "connected") return { kind: status, accepted: null, target: null };
    const kind = state?.availability ?? (state?.pauseReason
        ? state.pauseDetail === "verifying-context" ? "privacy-unknown" : "private"
        : state?.current ? "ready" : "none");
    const accepted = kind === "private" || kind === "none" ? null : state?.availability
        ? state.acceptedTarget ?? null : state?.current ?? null;
    return { kind, accepted, target: kind === "ready" ? accepted : null };
}

export function attachmentTarget(status: ConnectionStatus, state: ContextState | null, notePath: string | null | undefined): ContextSnapshot | null {
    return validNotePath(notePath) ? contextAccess(status, state).target : null;
}

/**
 * Editing SAVED groups (rename, icon, reorder, move notes between contexts, ...) targets a context by its persistent key and
 * never reads the live Windows context, so the desktop, an unrelated app, an unavailable context or a stopped companion must
 * not block it. Only an active or unverified browser privacy state does: while privacy is unknown or the window is private,
 * relationship changes wait. Display-only changes (name, icon, order, expansion) are never blocked.
 */
export function savedGroupEdits(status: ConnectionStatus, state: ContextState | null): { display: true; relationships: boolean; reason: string } {
    const kind = contextAccess(status, state).kind;
    const blocked = kind === "private" || kind === "privacy-unknown";
    return { display: true, relationships: !blocked,
        reason: kind === "private" ? "Unavailable in private browsing." : blocked ? "Wait for the browser page to be verified, or switch to another window, then try again." : "" };
}
