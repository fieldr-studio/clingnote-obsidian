import type { ClingNoteSettings, PauseState } from "./types";

export function pauseExpired(pause: PauseState | undefined, now: number, session: string): boolean {
    return pause?.kind === "timed" ? now >= pause.until : pause?.kind === "restart" ? pause.session !== session : false;
}
export function reconcilePause(settings: ClingNoteSettings, now: number, session: string): boolean {
    if (!settings.followEnabled && pauseExpired(settings.pause, now, session)) {
        settings.followEnabled = true; delete settings.pause; return true;
    }
    return false;
}
export function pauseLabel(pause: PauseState | undefined, now: number): string {
    if (pause?.kind === "timed") return `ClingNote: Paused · ${Math.max(0, Math.ceil((pause.until - now) / 60000))}m`;
    return pause?.kind === "restart" ? "ClingNote: Paused until restart" : "ClingNote: Paused";
}
