import { members } from "./mappings";
import type { ContextGroup, SidebarUiState } from "./types";

/**
 * Pure view-model of the ClingNote sidebar. No Obsidian imports, so the layout rules (grouping, Main first,
 * unattached classification, search, expansion, active highlighting) are unit-tested without a UI.
 * The model only reads data; it never changes an association or a Markdown file.
 */

export const DEFAULT_UI: SidebarUiState = { collapsed: [], unattachedExpanded: false, sort: "created" };
export const UNATTACHED_LIMIT = 300;

export type IconRef = { kind: "lucide" | "emoji"; value: string };

export interface NoteRowModel {
    path: string;
    name: string;
    main: boolean;
    missing: boolean;
    /** How many contexts this note belongs to (>=1 inside a group row). */
    contextCount: number;
}
export interface GroupModel {
    key: string;
    title: string;
    /** Full title plus location, for hover. */
    tooltip: string;
    customTitle: boolean;
    icon: IconRef;
    customIcon: boolean;
    expanded: boolean;
    active: boolean;
    notes: NoteRowModel[];
    totalNotes: number;
}
export interface SidebarModel {
    groups: GroupModel[];
    unattached: { expanded: boolean; notes: NoteRowModel[]; total: number; truncated: boolean };
    searching: boolean;
    /** Nothing at all to show for the current query. */
    noMatches: boolean;
}

export interface ModelInput {
    groups: Array<[string, ContextGroup]>;
    /** Every Markdown file path in the vault. */
    vaultNotes: string[];
    exists: (path: string) => boolean;
    ui: SidebarUiState;
    /** Context key that is active in Windows right now, if it has a group. */
    activeKey: string | null;
    /** Groups auto-expanded for the active context this session (not persisted). */
    transientExpanded?: ReadonlySet<string>;
    query?: string;
}

export function baseName(path: string): string { return (path.split("/").pop() ?? path).replace(/\.md$/i, ""); }

/** Display name: the user's custom name if set, otherwise the context's own label. Never used as identity. */
export function contextTitle(group: ContextGroup): { title: string; custom: boolean } {
    if (group.header.mode === "custom") return { title: group.header.label, custom: true };
    return { title: group.label.trim() || "Saved context", custom: false };
}

export function defaultIcon(key: string, group: ContextGroup): IconRef {
    if (key.startsWith("url:")) return { kind: "lucide", value: "globe" };
    if (group.navigation?.kind === "folder") return { kind: "lucide", value: "folder" };
    if (key.startsWith("file-id:") || key.startsWith("file:") || group.navigation?.kind === "file") return { kind: "lucide", value: "file" };
    return { kind: "lucide", value: "app-window" };
}
export function iconOf(key: string, group: ContextGroup): { icon: IconRef; custom: boolean } {
    const icon = group.icon;
    if (icon?.startsWith("lucide:")) return { icon: { kind: "lucide", value: icon.slice(7) }, custom: true };
    if (icon?.startsWith("emoji:")) return { icon: { kind: "emoji", value: icon.slice(6) }, custom: true };
    return { icon: defaultIcon(key, group), custom: false };
}

/** Where the context lives, for tooltips. Display only. */
export function contextLocation(key: string, group: ContextGroup): string {
    if (group.navigation?.kind === "page") return group.navigation.url;
    if (group.navigation && "path" in group.navigation) return group.navigation.path;
    if (key.startsWith("url:")) return key.slice(4).replace(/\?~[^#]*/, "");
    if (key.startsWith("window:")) return key.slice(7).split("|")[0];
    return "";
}

const lower = (text: string) => text.toLocaleLowerCase();

export function buildSidebarModel(input: ModelInput): SidebarModel {
    const query = lower((input.query ?? "").trim());
    const searching = query.length > 0;
    const counts = new Map<string, number>();
    for (const [, group] of input.groups) for (const path of members(group)) counts.set(path, (counts.get(path) ?? 0) + 1);
    const row = (path: string, group?: ContextGroup): NoteRowModel => ({
        path, name: baseName(path), main: !!group && group.mainNote === path, missing: !input.exists(path), contextCount: counts.get(path) ?? 0,
    });
    const ordered = input.ui.sort === "name"
        ? [...input.groups].sort((a, b) => contextTitle(a[1]).title.localeCompare(contextTitle(b[1]).title, undefined, { sensitivity: "base" }))
        : input.groups;

    const groups: GroupModel[] = [];
    for (const [key, group] of ordered) {
        const { title, custom } = contextTitle(group);
        const titleMatch = searching && lower(title).includes(query);
        const all = members(group);
        let shown = all;
        if (searching && !titleMatch) shown = all.filter(path => lower(baseName(path)).includes(query));
        if (searching && !shown.length) continue;
        const { icon, custom: customIcon } = iconOf(key, group);
        const location = contextLocation(key, group);
        const manuallyCollapsed = input.ui.collapsed.includes(key);
        groups.push({
            key, title, customTitle: custom, icon, customIcon,
            tooltip: location && location !== title ? `${title}\n${location}` : title,
            expanded: searching || !manuallyCollapsed || !!input.transientExpanded?.has(key),
            active: key === input.activeKey,
            notes: shown.map(path => row(path, group)),
            totalNotes: all.length,
        });
    }

    const attached = new Set(counts.keys());
    const loose = [...new Set(input.vaultNotes)].filter(path => !attached.has(path))
        .sort((a, b) => baseName(a).localeCompare(baseName(b), undefined, { sensitivity: "base" }));
    const matching = searching ? loose.filter(path => lower(baseName(path)).includes(query)) : loose;
    const unattached = {
        expanded: searching ? matching.length > 0 : input.ui.unattachedExpanded,
        notes: matching.slice(0, UNATTACHED_LIMIT).map(path => row(path)),
        total: matching.length,
        truncated: matching.length > UNATTACHED_LIMIT,
    };
    return { groups, unattached, searching, noMatches: searching && !groups.length && !matching.length };
}

/** Structural fingerprint: rebuild the DOM only when something visible changed (keeps scroll and focus calm). */
export function modelSignature(model: SidebarModel): string {
    return JSON.stringify([model.groups.map(g => [g.key, g.title, g.icon, g.expanded, g.tooltip, g.notes.map(n => [n.path, n.main, n.missing, n.contextCount]), g.totalNotes]),
        model.unattached.expanded, model.unattached.notes.map(n => [n.path, n.missing]), model.unattached.total, model.searching]);
}

/** Pure expansion-state transitions. A manual toggle is persisted; automatic expansion for the active context is not. */
export function toggleGroup(ui: SidebarUiState, key: string, expanded: boolean): SidebarUiState {
    const collapsed = new Set(ui.collapsed);
    if (expanded) collapsed.delete(key); else collapsed.add(key);
    return { ...ui, collapsed: [...collapsed].slice(-500) };
}
export function setAllGroups(ui: SidebarUiState, keys: string[], expanded: boolean): SidebarUiState {
    return { ...ui, collapsed: expanded ? [] : [...keys] };
}
/** Forget collapse state of contexts that no longer exist. */
export function pruneUi(ui: SidebarUiState, existingKeys: string[]): SidebarUiState {
    const keep = new Set(existingKeys);
    const collapsed = ui.collapsed.filter(key => keep.has(key));
    return collapsed.length === ui.collapsed.length ? ui : { ...ui, collapsed };
}

/**
 * First-launch activation of the ClingNote tab. A user who already has the view in their saved workspace, or who already has
 * saved contexts (an existing user), keeps their own layout; we only record that the decision was made so a later deliberate
 * switch to File Explorer is never overridden.
 */
export function shouldActivateSidebar(input: { alreadyActivated: boolean; firstRun: boolean; viewExists: boolean; hasSavedContexts: boolean }): boolean {
    if (input.alreadyActivated || input.viewExists) return false;
    return input.firstRun || !input.hasSavedContexts;
}
