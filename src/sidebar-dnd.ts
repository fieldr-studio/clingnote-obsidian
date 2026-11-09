import { members } from "./mappings";
import type { ContextGroup } from "./types";

/**
 * Pure drag-and-drop planning for the sidebar. It decides what a drop means (or why it is refused) from the saved
 * relationship data only, so every gesture is unit-tested without a UI. The view merely executes the plan through the
 * same follower actions as menus. Dropping never copies, moves, renames or deletes a Markdown file.
 */
export interface DragSource { path: string; /** Group the note was dragged from, or null when dragged from Unattached. */ fromKey: string | null }
export type DropTarget =
    | { kind: "main-row"; key: string }
    | { kind: "related-row"; key: string; path: string }
    | { kind: "group"; key: string }
    | { kind: "unattached" };

export type DropPlan =
    | { ok: true; op: "promote" | "reorder"; key: string; path: string; onto: string; hint: string }
    | { ok: true; op: "insert"; key: string; path: string; before?: string; hint: string }
    | { ok: true; op: "move"; key: string; to: string; path: string; hint: string }
    | { ok: false; hint: string };

export interface PlanContext {
    group: (key: string) => ContextGroup | undefined;
    title: (key: string) => string;
    noteExists: (path: string) => boolean;
}

const name = (path: string) => (path.split("/").pop() ?? path).replace(/\.md$/i, "");

/** `move` is true only when the user explicitly asked for it (Shift while dropping). Default is to add a relationship. */
export function planDrop(source: DragSource, target: DropTarget, move: boolean, ctx: PlanContext): DropPlan {
    if (!ctx.noteExists(source.path)) return { ok: false, hint: "That note is missing." };
    const label = name(source.path);
    if (target.kind === "unattached") {
        return source.fromKey === null
            ? { ok: false, hint: "Already unattached." }
            : { ok: false, hint: "To unattach a note, use “Remove from this context”." };
    }
    const group = ctx.group(target.key);
    if (!group) return { ok: false, hint: "That context no longer exists." };
    const title = ctx.title(target.key);
    if (source.fromKey === target.key) {
        const isMain = group.mainNote === source.path;
        if (target.kind === "main-row") {
            return isMain ? { ok: false, hint: `“${label}” is already Main.` }
                : { ok: true, op: "promote", key: target.key, path: source.path, onto: group.mainNote, hint: `Make “${label}” Main (the old Main stays attached)` };
        }
        if (target.kind === "related-row") {
            if (isMain) return { ok: false, hint: "To change Main, drag another note onto it." };
            return target.path === source.path ? { ok: false, hint: "Drop on another note to reorder." }
                : { ok: true, op: "reorder", key: target.key, path: source.path, onto: target.path, hint: `Move “${label}” here` };
        }
        return { ok: false, hint: `“${label}” is already attached to “${title}”.` };
    }
    if (members(group).includes(source.path)) return { ok: false, hint: `Already attached to “${title}”.` };
    const before = target.kind === "related-row" ? target.path : target.kind === "main-row" ? group.relatedNotes[0] : undefined;
    if (move && source.fromKey !== null) {
        return { ok: true, op: "move", key: source.fromKey, to: target.key, path: source.path, hint: `Move “${label}” to “${title}” (removed from its current context)` };
    }
    return { ok: true, op: "insert", key: target.key, path: source.path, ...(before !== undefined ? { before } : {}),
        hint: source.fromKey === null ? `Attach “${label}” to “${title}”` : `Also attach “${label}” to “${title}” (hold Shift to move)` };
}
