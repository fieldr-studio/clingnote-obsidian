import type { MappingData, NoteMapping, MappingActivity, NavigationTarget, ContextGroup, GroupData, GroupHeader } from "./types";
import { notePath as validNotePath } from "./validation";
import { validNavigation } from "./navigation";
import { freshActivity } from "./activity";

/** "lucide:<name>" or "emoji:<chars>" only; anything else is dropped (it is display data, never identity). */
export function validIcon(value: unknown): value is string {
    if (typeof value !== "string") return false;
    if (/^lucide:[a-z0-9][a-z0-9-]{0,63}$/.test(value)) return true;
    if (!value.startsWith("emoji:")) return false;
    const chars = value.slice(6);
    if (chars.length < 1 || chars.length > 16) return false;
    let nonAscii = false;
    for (const ch of chars) {
        const code = ch.codePointAt(0)!;
        if (code < 32 || ch === "<" || ch === ">") return false;
        if (code > 126) nonAscii = true;
    }
    return nonAscii;
}

export function members(group: ContextGroup): string[] { return [group.mainNote, ...group.relatedNotes]; }
export function groupTitle(group: ContextGroup): string | null {
    return group.header.mode === "hidden" ? null : group.header.mode === "custom" ? group.header.label : group.label || "Saved context";
}
function fromMapping(value: NoteMapping): ContextGroup {
    return { mainNote: value.notePath, relatedNotes: [...(value.relatedNotes ?? [])], label: value.label,
        header: structuredClone(value.header ?? { mode: "context" }), ...(validIcon(value.icon) ? { icon: value.icon } : {}), ...(validNavigation(value.navigation) ? { navigation: structuredClone(value.navigation) } : {}) };
}
function snapshot(group?: ContextGroup): NoteMapping | undefined {
    return group && { notePath: group.mainNote, label: group.label, relatedNotes: [...group.relatedNotes], header: structuredClone(group.header),
        ...(group.icon ? { icon: group.icon } : {}),
        ...(group.navigation ? { navigation: structuredClone(group.navigation) } : {}) };
}
function projection(group: ContextGroup): NoteMapping {
    return { notePath: group.mainNote, label: group.label, ...(group.navigation ? { navigation: structuredClone(group.navigation) } : {}) };
}

/** One context owns one group. get/entries project Main through the existing follower seam.
 * Membership is vault-relative and not constrained to one group per note. No vault writes here.
 */
export class MappingStore {
    private groups: Record<string, ContextGroup> = Object.create(null);
    private activity: MappingActivity[] = [];
    private nextId = 1;
    constructor(data?: Partial<MappingData> | null) {
        if (data?.version === 1 && data.mappings) {
            for (const [key, value] of Object.entries(data.mappings)) if (value && validNotePath(value.notePath))
                this.groups[key] = fromMapping({ ...value, label: typeof value.label === "string" ? value.label : "" });
        } else if (data?.version === 2 && data.groups) {
            for (const [key, value] of Object.entries(data.groups)) {
                const group = structuredClone(value);
                if (group.icon !== undefined && !validIcon(group.icon)) delete group.icon;
                this.groups[key] = group;
            }
        }
        this.activity = (data?.activity ?? []).slice(-20).map(item => ({ ...structuredClone(item),
            ...(item.before ? { before: snapshot(fromMapping(item.before)) } : {}),
            ...(item.after ? { after: snapshot(fromMapping(item.after)) } : {}) }));
        this.nextId = Math.max(0, ...this.activity.map(item => item.id)) + 1;
    }
    private change(key: string, next?: ContextGroup): boolean {
        const before = snapshot(this.groups[key]), after = snapshot(next);
        if (JSON.stringify(before) === JSON.stringify(after)) return false;
        for (const item of this.activity) if (item.key === key) item.undoable = false;
        this.activity.push({ id: this.nextId++, at: Date.now(), key, ...(before ? { before } : {}), ...(after ? { after } : {}), undoable: true });
        this.activity = this.activity.slice(-20);
        if (next) this.groups[key] = structuredClone(next); else delete this.groups[key];
        return true;
    }
    recent(): MappingActivity[] { return [...this.activity].reverse().map(item => structuredClone(item)); }
    undo(id: number, noteExists: (path: string) => boolean, now = Date.now()): boolean {
        const item = this.activity.find(entry => entry.id === id);
        if (!item || !freshActivity(item, now) || JSON.stringify(snapshot(this.groups[item.key])) !== JSON.stringify(item.after) ||
            (item.before && !members(fromMapping(item.before)).every(noteExists))) return false;
        if (item.before) this.groups[item.key] = fromMapping(item.before); else delete this.groups[item.key];
        for (const entry of this.activity) if (entry.key === item.key) entry.undoable = false;
        return true;
    }
    updateNavigation(key: string, navigation: NavigationTarget): boolean {
        const group = this.groups[key];
        if (!group || JSON.stringify(group.navigation) === JSON.stringify(navigation)) return false;
        group.navigation = structuredClone(navigation);
        for (const item of this.activity) if (item.key === key && item.undoable && item.after) item.after.navigation = structuredClone(navigation);
        return true;
    }
    get(key: string): NoteMapping | undefined { const group = this.groups[key]; return group && projection(group); }
    group(key: string): ContextGroup | undefined { const group = this.groups[key]; return group && structuredClone(group); }
    groupEntries(): Array<[string, ContextGroup]> { return Object.entries(this.groups).map(([k, v]) => [k, structuredClone(v)]); }
    entries(): Array<[string, NoteMapping]> { return Object.entries(this.groups).map(([k, v]) => [k, projection(v)]); }
    keysForNote(path: string): string[] { return Object.keys(this.groups).filter(key => members(this.groups[key]).includes(path)); }
    /** Set Main, retaining the previous Main as the first Related note. */
    attach(key: string, path: string, label: string, navigation?: NavigationTarget): NoteMapping | undefined {
        const old = this.groups[key], target = navigation ?? old?.navigation;
        const next: ContextGroup = { mainNote: path, relatedNotes: old ? members(old).filter(p => p !== path) : [],
            label, header: old?.header ?? { mode: "context" }, ...(target ? { navigation: target } : {}) };
        this.change(key, next);
        return old && old.mainNote !== path ? projection(old) : undefined;
    }
    addNote(key: string, path: string, label: string, navigation?: NavigationTarget): boolean {
        if (!validNotePath(path)) return false;
        const group = this.groups[key];
        if (!group) { this.attach(key, path, label, navigation); return true; }
        if (members(group).includes(path)) return false;
        return this.change(key, { ...group, relatedNotes: [...group.relatedNotes, path] });
    }
    makeMain(key: string, path: string): boolean {
        const group = this.groups[key];
        if (!group || path === group.mainNote || !group.relatedNotes.includes(path)) return false;
        return this.change(key, { ...group, mainNote: path, relatedNotes: members(group).filter(p => p !== path) });
    }
    removeNote(key: string, path: string): boolean {
        const group = this.groups[key];
        if (!group || !members(group).includes(path)) return false;
        const remaining = members(group).filter(p => p !== path);
        return this.change(key, remaining.length ? { ...group, mainNote: remaining[0], relatedNotes: remaining.slice(1) } : undefined);
    }
    reorderRelated(key: string, order: string[]): boolean {
        const group = this.groups[key];
        if (!group || order.length !== group.relatedNotes.length || new Set(order).size !== order.length || order.some(p => !group.relatedNotes.includes(p))) return false;
        return this.change(key, { ...group, relatedNotes: [...order] });
    }
    dropNote(key: string, dragged: string, onto: string): boolean {
        const group = this.groups[key];
        if (!group || dragged === onto || !group.relatedNotes.includes(dragged)) return false;
        if (onto === group.mainNote) return this.makeMain(key, dragged);
        if (!group.relatedNotes.includes(onto)) return false;
        const order = group.relatedNotes.filter(p => p !== dragged);
        order.splice(order.indexOf(onto) + (group.relatedNotes.indexOf(dragged) < group.relatedNotes.indexOf(onto) ? 1 : 0), 0, dragged);
        return this.reorderRelated(key, order);
    }
    setHeader(key: string, header: GroupHeader): boolean {
        const group = this.groups[key];
        if (!group || (header.mode === "custom" && (!header.label.trim() || header.label.length > 200))) return false;
        return this.change(key, { ...group, header: header.mode === "custom" ? { mode: "custom", label: header.label.trim() } : header });
    }
    /** Display icon only. null/undefined restores the default. */
    setIcon(key: string, icon: string | null | undefined): boolean {
        const group = this.groups[key];
        if (!group || (icon != null && !validIcon(icon))) return false;
        const { icon: _old, ...rest } = group;
        return this.change(key, icon ? { ...rest, icon } : rest);
    }
    /** Restore the default name (the context's own label) and default icon in one step. */
    restoreAppearance(key: string): boolean {
        const group = this.groups[key];
        if (!group) return false;
        const { icon: _old, ...rest } = group;
        return this.change(key, { ...rest, header: { mode: "context" } });
    }
    /** Add an existing note to a saved context at a position (before a secondary note, or at the top/end). One change, no duplicates. */
    insertNote(key: string, path: string, before?: string): boolean {
        const group = this.groups[key];
        if (!group || !validNotePath(path) || members(group).includes(path)) return false;
        const related = [...group.relatedNotes];
        const at = before !== undefined && related.includes(before) ? related.indexOf(before) : before === group.mainNote ? 0 : related.length;
        related.splice(at, 0, path);
        return this.change(key, { ...group, relatedNotes: related });
    }
    /** Add to another context, then remove from the first. Both sides are validated before anything changes. */
    moveNote(from: string, to: string, path: string): boolean {
        const source = this.groups[from], target = this.groups[to];
        if (!source || !target || from === to || !members(source).includes(path) || members(target).includes(path) || !validNotePath(path)) return false;
        this.insertNote(to, path);
        this.removeNote(from, path);
        return true;
    }
    /** Every distinct note path currently attached to any context. */
    attachedPaths(): Set<string> { return new Set(Object.values(this.groups).flatMap(members)); }
    /** Contexts a note belongs to, with its role in each. Reverse view of the same data as groups. */
    contextsForNote(path: string): Array<{ key: string; group: ContextGroup; main: boolean }> {
        return Object.entries(this.groups).filter(([, g]) => members(g).includes(path))
            .map(([key, g]) => ({ key, group: structuredClone(g), main: g.mainNote === path }));
    }
    detach(key: string): boolean { return !!this.groups[key] && this.change(key); }
    private updatePaths(oldPath: string, newPath?: string): number {
        const affected = (p: string) => p === oldPath || p.startsWith(oldPath + "/");
        let changes = 0;
        let invalidated = false;
        for (const item of this.activity) if (item.undoable && [item.before, item.after].some(value => value && members(fromMapping(value)).some(affected))) {
            item.undoable = false; invalidated = true;
        }
        for (const [key, group] of Object.entries(this.groups)) {
            if (!members(group).some(affected)) continue;
            const paths = [...new Set(members(group).flatMap(path => {
                if (!affected(path)) return [path];
                const next = newPath === undefined ? null : newPath + path.slice(oldPath.length);
                return next && validNotePath(next) ? [next] : [];
            }))];
            if (paths.length) this.groups[key] = { ...group, mainNote: paths[0], relatedNotes: paths.slice(1) };
            else delete this.groups[key];
            for (const item of this.activity) if (item.key === key) item.undoable = false;
            changes++;
        }
        return Math.max(changes, invalidated ? 1 : 0);
    }
    renameNote(oldPath: string, newPath: string): number { return this.updatePaths(oldPath, newPath); }
    deleteNote(path: string): number { return this.updatePaths(path); }
    toJSON(): GroupData { return { version: 2, groups: structuredClone({ ...this.groups }), activity: structuredClone(this.activity) }; }
}
