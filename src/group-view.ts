import { ItemView, Menu, Modal, TFile, setIcon, setTooltip, type WorkspaceLeaf } from "obsidian";
import type ClingNotePlugin from "./main";
import { attachExplanation } from "./presentation";
import { connectionNotice, downloadUrl, COMPANION_DOWNLOAD_URL } from "./onboarding";
import { sidebarLicenseNote } from "./license";
import { contextAccess } from "./context-policy";
import { buildSidebarModel, modelSignature, type GroupModel, type NoteRowModel, type SidebarModel } from "./sidebar-model";
import { planDrop, type DragSource, type DropPlan, type DropTarget } from "./sidebar-dnd";

export const GROUP_VIEW = "clingnote-context-groups";

/**
 * ClingNote sidebar: compact, cascading context groups with a collapsible Unattached section.
 * It only reads the shared association data and calls the same follower actions as every other surface.
 * Automatic refresh changes this view's DOM and scroll only; it never changes the active leaf or any file.
 *
 * Pause: the companion keeps observing and the plugin keeps receiving state, but while following is paused this view shows no
 * active-context highlight and performs no automatic expand/scroll. Resuming highlights the latest verified context.
 */
export class ContextGroupView extends ItemView {
    private unsubscribe?: () => void;
    private signature = "";
    private query = "";
    private searchOpen = false;
    private dragged: DragSource | null = null;
    private transient = new Set<string>();
    private lastActiveKey: string | null = null;
    private pendingScroll: string | null = null;
    private bodyEl?: HTMLElement;
    private statusEl?: HTMLElement;
    private noticeEl?: HTMLElement;
    private noticeKey = "";
    private searchRow?: HTMLElement;
    private searchInput?: HTMLInputElement;
    private addButton?: HTMLButtonElement;
    private pausedBadge?: HTMLElement;
    private statusText = "";
    private vaultTimer?: ReturnType<typeof setTimeout>;

    constructor(leaf: WorkspaceLeaf, private plugin: ClingNotePlugin) { super(leaf); }
    getViewType(): string { return GROUP_VIEW; }
    getDisplayText(): string { return "ClingNote"; }
    getIcon(): string { return "link"; }

    async onOpen(): Promise<void> {
        this.contentEl.addClass("clingnote-groups");
        this.unsubscribe = this.plugin.onSurfaceRefresh(() => this.render());
        this.registerEvent(this.app.workspace.on("file-open", () => this.render()));
        const vaultChanged = () => { clearTimeout(this.vaultTimer); this.vaultTimer = setTimeout(() => this.render(true), 150); };
        this.registerEvent(this.app.vault.on("create", vaultChanged));
        this.registerEvent(this.app.vault.on("delete", vaultChanged));
        this.registerEvent(this.app.vault.on("rename", vaultChanged));
        this.render();
    }
    async onClose(): Promise<void> { this.unsubscribe?.(); clearTimeout(this.vaultTimer); this.dragged = null; }

    /** Called by the plugin when something outside the view wants this context visible (note-side "Show in sidebar"). */
    reveal(key: string): void {
        this.query = ""; this.searchOpen = false; if (this.searchInput) this.searchInput.value = "";
        this.transient.add(key); this.pendingScroll = key; this.render(true);
    }

    private button(parent: HTMLElement, icon: string, label: string, action: (event: MouseEvent) => void, cls = ""): HTMLButtonElement {
        const button = parent.createEl("button", { cls: `clickable-icon clingnote-group-control ${cls}`.trim(), attr: { "aria-label": label, type: "button" } });
        setIcon(button, icon); setTooltip(button, label); button.onclick = action; return button;
    }

    private build(): void {
        const follower = this.plugin.follower;
        const header = this.contentEl.createDiv({ cls: "clingnote-sb-header" });
        const titleRow = header.createDiv({ cls: "clingnote-sb-titlerow" });
        titleRow.createSpan({ text: "ClingNote", cls: "clingnote-panel-title" });
        this.pausedBadge = titleRow.createEl("button", { text: "Paused", cls: "clingnote-paused-badge", attr: { type: "button", "aria-label": "Following is paused. Click to resume." } });
        setTooltip(this.pausedBadge, "Following is paused: notes will not open and the highlight is frozen. Click to resume.");
        this.pausedBadge.onclick = () => void this.plugin.setFollowing(true);
        const actions = header.createDiv({ cls: "clingnote-sb-actions" });
        this.button(actions, "search", "Search contexts and notes", () => {
            this.searchOpen = !this.searchOpen;
            this.searchRow!.toggleClass("is-open", this.searchOpen);
            if (this.searchOpen) this.searchInput!.focus(); else this.setQuery("");
        });
        this.addButton = this.button(actions, "plus", "Attach current note to the current context", () => void this.plugin.run(follower.addCurrentNote()));
        this.button(actions, "settings", "Connection and settings", () => this.plugin.openSettings());
        this.button(actions, "ellipsis", "Organize", event => this.organizeMenu().showAtMouseEvent(event));
        this.searchRow = this.contentEl.createDiv({ cls: "clingnote-sb-search" });
        this.searchInput = this.searchRow.createEl("input", { type: "search", attr: { placeholder: "Search contexts and notes", "aria-label": "Search contexts and notes" } });
        this.searchInput.oninput = () => this.setQuery(this.searchInput!.value);
        this.searchInput.onkeydown = event => {
            if (event.key !== "Escape") return;
            this.searchInput!.value = ""; this.searchOpen = false; this.setQuery("");
        };
        this.bodyEl = this.contentEl.createDiv({ cls: "clingnote-sb-body" });
        this.statusEl = this.contentEl.createDiv({ cls: "clingnote-group-status" });
        this.noticeEl = this.contentEl.createDiv({ cls: "clingnote-group-status clingnote-connection-notice" });
    }

    /** Small connection hint under the list (no banner): why nothing is following, with one recovery action. */
    private renderNotice(): void {
        const follower = this.plugin.follower;
        const url = downloadUrl(COMPANION_DOWNLOAD_URL);
        const license = this.plugin.license;
        let notice = connectionNotice(follower.status, follower.connectionIssue, !!url);
        if (!notice && follower.status === "connected") {
            const text = license.outdated ? "Update the ClingNote companion to use automatic following." : sidebarLicenseNote(license.status);
            if (text) notice = { text, action: license.outdated ? null : "license" };
        }
        const key = notice ? `${notice.text}|${notice.action}` : "";
        if (key === this.noticeKey) return;
        this.noticeKey = key; this.noticeEl!.empty();
        if (!notice) return;
        this.noticeEl!.createSpan({ text: notice.text + " " });
        if (notice.action === "download" && url) this.noticeEl!.createEl("a", { text: "Download companion", href: url, attr: { target: "_blank", rel: "noopener noreferrer" } });
        else if (notice.action === "license") this.noticeEl!.createEl("a", { text: "License settings", href: "#" }).onclick = event => { event.preventDefault(); this.plugin.openSettings(); };
        else if (notice.action === "retry") this.noticeEl!.createEl("a", { text: "Retry", href: "#", cls: "clingnote-notice-retry" }).onclick = event => { event.preventDefault(); void follower.reconnect(); };
    }
    private setQuery(value: string): void { this.query = value; this.render(true); }

    private organizeMenu(): Menu {
        const menu = new Menu(); const ui = this.plugin.ui();
        const keys = this.plugin.mappings.groupEntries().map(([key]) => key);
        menu.addItem(item => item.setTitle("Expand all contexts").setIcon("chevrons-up-down").onClick(() => this.plugin.setAllExpanded(keys, true)));
        menu.addItem(item => item.setTitle("Collapse all contexts").setIcon("chevrons-down-up").onClick(() => this.plugin.setAllExpanded(keys, false)));
        menu.addSeparator();
        menu.addItem(item => item.setTitle("Sort contexts: oldest first").setChecked(ui.sort === "created").onClick(() => this.plugin.setSort("created")));
        menu.addItem(item => item.setTitle("Sort contexts: by name").setChecked(ui.sort === "name").onClick(() => this.plugin.setSort("name")));
        menu.addSeparator();
        menu.addItem(item => item.setTitle("Accent color…").setIcon("palette").onClick(() => this.plugin.chooseAccent()));
        menu.addSeparator();
        const following = this.plugin.settings.followEnabled;
        menu.addItem(item => item.setTitle(following ? "Pause following…" : "Resume following").setIcon(following ? "pause" : "play")
            .onClick(() => following ? this.plugin.showPauseOptions() : void this.plugin.setFollowing(true)));
        return menu;
    }

    /** The context highlighted right now. While paused there is none: only neutral note selection remains. */
    private highlightKey(access: ReturnType<typeof contextAccess>, groupKeys: string[]): string | null {
        const accepted = access.accepted?.key ?? null;
        const live = accepted && groupKeys.includes(accepted) ? accepted : null;
        return this.plugin.settings.followEnabled && this.plugin.license.entitled() ? live : null;
    }

    private model(access: ReturnType<typeof contextAccess>): SidebarModel {
        const groups = this.plugin.mappings.groupEntries();
        return buildSidebarModel({
            groups, vaultNotes: this.app.vault.getMarkdownFiles().map(file => file.path),
            exists: path => this.app.vault.getAbstractFileByPath(path) instanceof TFile,
            ui: this.plugin.ui(), activeKey: this.highlightKey(access, groups.map(([key]) => key)), transientExpanded: this.transient, query: this.query,
        });
    }

    private render(force = false): void {
        const follower = this.plugin.follower;
        if (!follower) return;
        if (!this.bodyEl) this.build();
        const access = contextAccess(follower.status, follower.lastState);
        const privacy = access.kind === "private";
        const following = this.plugin.settings.followEnabled && this.plugin.license.entitled();
        const activeNote = this.app.workspace.getActiveFile()?.path;
        this.pausedBadge!.hidden = this.plugin.settings.followEnabled;
        this.contentEl.toggleClass("is-paused", !this.plugin.settings.followEnabled);
        this.addButton!.disabled = !this.plugin.attachTarget(activeNote);
        const statusText = this.dropHint || attachExplanation(follower.status, follower.lastState, activeNote);
        const disconnected = access.kind === "disconnected" && !this.dropHint;
        const shown = disconnected ? "" : statusText; // a disconnected companion is explained by the notice below instead
        if (shown !== this.statusText) { this.statusText = shown; this.statusEl!.setText(shown); }
        this.renderNotice();
        setTooltip(this.addButton!, attachExplanation(follower.status, follower.lastState, activeNote) || "Attach this note to the current context; the first attached note becomes Main");
        this.searchRow!.toggleClass("is-open", this.searchOpen);
        this.bodyEl!.hidden = privacy;
        this.bodyEl!.setAttribute("aria-hidden", String(privacy));
        this.bodyEl!.inert = privacy;
        this.searchRow!.inert = privacy;
        if (privacy) { this.dragged = null; return; }
        if (this.dragged && !force) return;

        let model = this.model(access);
        const active = model.groups.find(group => group.active);
        // Automatic navigation (expand + scroll for the active context) only happens while following.
        if (following && (active?.key ?? null) !== this.lastActiveKey) {
            this.lastActiveKey = active?.key ?? null;
            if (active) {
                if (!active.expanded) { this.transient.add(active.key); model = this.model(access); }
                this.pendingScroll = active.key;
            }
        }
        const signature = modelSignature(model);
        if (signature !== this.signature) {
            this.signature = signature;
            const scroll = this.contentEl.scrollTop;
            this.draw(model);
            this.contentEl.scrollTop = scroll;
        }
        this.highlight(model, activeNote);
        if (this.pendingScroll && !this.query && following) {
            const key = this.pendingScroll; this.pendingScroll = null;
            const target = Array.from(this.bodyEl!.querySelectorAll<HTMLElement>(".clingnote-group")).find(section => section.dataset.contextKey === key);
            target?.scrollIntoView({ block: "nearest", behavior: "smooth" });
        } else if (!following) this.pendingScroll = this.pendingScroll && this.query ? this.pendingScroll : null;
    }

    private highlight(model: SidebarModel, activeNote?: string): void {
        const activeKey = model.groups.find(group => group.active)?.key ?? null;
        this.bodyEl!.querySelectorAll<HTMLElement>(".clingnote-group").forEach(section => {
            const active = section.dataset.contextKey === activeKey;
            section.toggleClass("is-active-context", active);
            section.setAttribute("aria-current", active ? "true" : "false");
        });
        this.bodyEl!.querySelectorAll<HTMLElement>(".clingnote-group-note").forEach(row => {
            row.toggleClass("is-current-note", row.dataset.notePath === activeNote);
            row.toggleClass("is-active-main", row.hasClass("is-main") && row.closest<HTMLElement>(".clingnote-group")?.dataset.contextKey === activeKey);
        });
    }

    // ---- drag and drop -------------------------------------------------------------------------------------------------

    private dropHint = "";
    private planContext() {
        return {
            group: (key: string) => this.plugin.mappings.group(key),
            title: (key: string) => { const group = this.plugin.mappings.group(key); return group ? this.plugin.contextName(group) : "context"; },
            noteExists: (path: string) => this.app.vault.getAbstractFileByPath(path) instanceof TFile,
        };
    }
    private setHint(text: string): void { this.dropHint = text; this.statusText = text; this.statusEl?.setText(text); }
    private clearDropState(): void {
        this.dragged = null;
        if (this.dropHint) { this.dropHint = ""; this.statusText = ""; }
        this.bodyEl?.querySelectorAll<HTMLElement>(".is-drop-target, .is-drop-invalid, .is-drop-before").forEach(el => el.removeClass("is-drop-target", "is-drop-invalid", "is-drop-before"));
    }
    private makeDraggable(el: HTMLElement, source: DragSource): void {
        el.draggable = !this.query;
        el.ondragstart = event => {
            this.dragged = source;
            event.dataTransfer?.setData("application/x-clingnote-note", source.path);
            if (event.dataTransfer) event.dataTransfer.effectAllowed = "copyMove";
        };
        el.ondragend = () => { this.clearDropState(); this.render(true); };
    }
    private makeDropTarget(el: HTMLElement, target: DropTarget): void {
        const over = (event: DragEvent) => {
            if (!this.dragged) return;
            const plan = planDrop(this.dragged, target, event.shiftKey, this.planContext());
            el.removeClass("is-drop-target", "is-drop-invalid", "is-drop-before");
            this.setHint(plan.hint);
            if (!plan.ok) { el.addClass("is-drop-invalid"); if (event.dataTransfer) event.dataTransfer.dropEffect = "none"; return; }
            event.preventDefault();
            el.addClass(plan.op === "insert" && target.kind === "related-row" ? "is-drop-before" : "is-drop-target");
            if (event.dataTransfer) event.dataTransfer.dropEffect = plan.op === "move" || plan.op === "promote" || plan.op === "reorder" ? "move" : "copy";
        };
        el.ondragover = over; el.ondragenter = over;
        el.ondragleave = () => el.removeClass("is-drop-target", "is-drop-invalid", "is-drop-before");
        el.ondrop = event => {
            event.preventDefault(); event.stopPropagation();
            const source = this.dragged; this.clearDropState();
            if (!source) return;
            const plan = planDrop(source, target, event.shiftKey, this.planContext());
            if (plan.ok) void this.execute(plan); else this.plugin.notify(plan.hint);
            this.render(true);
        };
    }
    private execute(plan: Extract<DropPlan, { ok: true }>): Promise<void> {
        const follower = this.plugin.follower;
        switch (plan.op) {
            case "promote": case "reorder": return this.plugin.run(follower.changeGroup(plan.key, { kind: "drop", path: plan.path, onto: plan.onto }));
            case "insert": return this.plugin.run(follower.changeGroup(plan.key, { kind: "insert", path: plan.path, ...(plan.before !== undefined ? { before: plan.before } : {}) }));
            case "move": return this.plugin.run(follower.changeGroup(plan.key, { kind: "moveTo", path: plan.path, to: plan.to }));
        }
    }

    // ---- drawing -------------------------------------------------------------------------------------------------------

    private draw(model: SidebarModel): void {
        const body = this.bodyEl!; body.empty();
        if (model.noMatches) body.createEl("p", { text: "No contexts or notes match.", cls: "clingnote-group-empty" });
        else if (!model.groups.length && !model.searching) body.createEl("p", { text: "No contexts yet. Switch to a file, app or page, open a note, then use + to attach it. The first attached note becomes Main.", cls: "clingnote-group-empty" });
        for (const group of model.groups) this.drawGroup(body, group);
        if (model.unattached.total || !model.searching) this.drawUnattached(body, model);
    }

    private drawGroup(parent: HTMLElement, group: GroupModel): void {
        const section = parent.createDiv({ cls: "clingnote-group" });
        section.dataset.contextKey = group.key;
        const head = section.createDiv({ cls: "clingnote-group-heading" });
        const toggle = head.createEl("button", { cls: "clingnote-group-toggle", attr: { "aria-expanded": String(group.expanded), type: "button", "aria-label": `${group.title}: ${group.expanded ? "collapse" : "expand"}` } });
        const chevron = toggle.createSpan({ cls: "clingnote-chevron" }); setIcon(chevron, group.expanded ? "chevron-down" : "chevron-right");
        const icon = toggle.createSpan({ cls: "clingnote-group-icon" }); this.plugin.paintIcon(icon, group.icon);
        toggle.createSpan({ text: group.title, cls: "clingnote-group-title" });
        toggle.createSpan({ text: String(group.totalNotes), cls: "clingnote-group-count", attr: { "aria-label": `${group.totalNotes} notes` } });
        setTooltip(toggle, group.tooltip);
        toggle.onclick = () => this.plugin.toggleGroup(group.key, !group.expanded);
        this.button(head, "ellipsis", "Context actions", event => this.groupMenu(group).showAtMouseEvent(event));
        head.oncontextmenu = event => { event.preventDefault(); this.groupMenu(group).showAtMouseEvent(event); };
        this.makeDropTarget(head, { kind: "group", key: group.key });
        if (!group.expanded) return;
        const list = section.createDiv({ cls: "clingnote-group-notes" });
        const related = this.plugin.mappings.group(group.key)?.relatedNotes ?? [];
        for (const note of group.notes) this.noteRow(list, group, note, related);
    }

    private noteRow(parent: HTMLElement, group: GroupModel, note: NoteRowModel, related: string[]): void {
        const row = parent.createDiv({ cls: note.main ? "clingnote-group-note is-main" : "clingnote-group-note is-related" });
        row.dataset.notePath = note.path;
        const marker = row.createSpan({ cls: "clingnote-note-marker" }); setIcon(marker, note.main ? "star" : "file-text");
        setTooltip(marker, note.main ? "Main: opens when this context activates" : "Attached note");
        const open = row.createEl("button", { text: note.name + (note.missing ? " (missing)" : ""), cls: "clingnote-note-name" });
        setTooltip(open, note.path); open.disabled = note.missing;
        open.onclick = () => this.plugin.openNotePath(note.path);
        if (note.contextCount > 1) {
            const shared = row.createSpan({ cls: "clingnote-shared", attr: { "aria-label": `In ${note.contextCount} contexts` } });
            setIcon(shared, "link-2"); shared.createSpan({ text: String(note.contextCount) });
            setTooltip(shared, `Same note, attached to ${note.contextCount} contexts`);
            shared.onclick = () => this.plugin.showAttachedContexts(note.path);
        }
        this.button(row, "ellipsis", "Note actions", event => this.noteMenu(group.key, note, related).showAtMouseEvent(event));
        row.oncontextmenu = event => { event.preventDefault(); this.noteMenu(group.key, note, related).showAtMouseEvent(event); };
        this.makeDraggable(row, { path: note.path, fromKey: group.key });
        this.makeDropTarget(row, note.main ? { kind: "main-row", key: group.key } : { kind: "related-row", key: group.key, path: note.path });
    }

    private drawUnattached(parent: HTMLElement, model: SidebarModel): void {
        const section = parent.createDiv({ cls: "clingnote-unattached" });
        const head = section.createDiv({ cls: "clingnote-group-heading" });
        const expanded = model.unattached.expanded;
        const toggle = head.createEl("button", { cls: "clingnote-group-toggle", attr: { "aria-expanded": String(expanded), type: "button" } });
        const chevron = toggle.createSpan({ cls: "clingnote-chevron" }); setIcon(chevron, expanded ? "chevron-down" : "chevron-right");
        const icon = toggle.createSpan({ cls: "clingnote-group-icon" }); setIcon(icon, "files");
        toggle.createSpan({ text: "Unattached", cls: "clingnote-group-title" });
        toggle.createSpan({ text: String(model.unattached.total), cls: "clingnote-group-count" });
        setTooltip(toggle, "Notes that are not attached to any context. Drag one onto a context to attach it.");
        toggle.onclick = () => this.plugin.setUnattachedExpanded(!expanded);
        this.makeDropTarget(head, { kind: "unattached" });
        if (!expanded) return;
        const list = section.createDiv({ cls: "clingnote-group-notes" });
        if (!model.unattached.notes.length) list.createEl("p", { text: "Every note is attached to a context.", cls: "clingnote-group-empty" });
        for (const note of model.unattached.notes) {
            const row = list.createDiv({ cls: "clingnote-group-note is-related is-unattached" });
            row.dataset.notePath = note.path;
            const marker = row.createSpan({ cls: "clingnote-note-marker" }); setIcon(marker, "file-text");
            const open = row.createEl("button", { text: note.name, cls: "clingnote-note-name" });
            setTooltip(open, note.path); open.onclick = () => this.plugin.openNotePath(note.path);
            this.button(row, "ellipsis", "Note actions", event => this.unattachedMenu(note).showAtMouseEvent(event));
            row.oncontextmenu = event => { event.preventDefault(); this.unattachedMenu(note).showAtMouseEvent(event); };
            this.makeDraggable(row, { path: note.path, fromKey: null });
            this.makeDropTarget(row, { kind: "unattached" });
        }
        if (model.unattached.truncated) list.createEl("p", { text: `Showing the first ${model.unattached.notes.length} of ${model.unattached.total}. Search to narrow.`, cls: "clingnote-group-empty" });
    }

    private noteMenu(key: string, note: NoteRowModel, related: string[]): Menu {
        const menu = new Menu(); const follower = this.plugin.follower;
        menu.addItem(item => item.setTitle("Open note").setIcon("file-text").setDisabled(note.missing).onClick(() => this.plugin.openNotePath(note.path)));
        if (!note.main) {
            menu.addItem(item => item.setTitle("Make Main for this context").setIcon("star").setDisabled(note.missing)
                .onClick(() => this.plugin.run(follower.changeGroup(key, { kind: "main", path: note.path }))));
            const index = related.indexOf(note.path);
            for (const [label, delta] of [["Move up", -1], ["Move down", 1]] as const) menu.addItem(item => item.setTitle(label)
                .setDisabled(index < 0 || index + delta < 0 || index + delta >= related.length || !!this.query).onClick(() => {
                    const order = [...related]; [order[index], order[index + delta]] = [order[index + delta], order[index]];
                    return this.plugin.run(follower.changeGroup(key, { kind: "reorder", order }));
                }));
        }
        menu.addSeparator();
        menu.addItem(item => item.setTitle("View attached contexts").setIcon("link-2").onClick(() => this.plugin.showAttachedContexts(note.path)));
        menu.addItem(item => item.setTitle("Attach to another context…").setIcon("plus").onClick(() => this.plugin.attachToAnotherContext(note.path)));
        menu.addItem(item => item.setTitle("Move to another context…").setIcon("arrow-right-left").onClick(() => this.plugin.moveToAnotherContext(key, note.path)));
        menu.addSeparator();
        menu.addItem(item => item.setTitle(note.main && related.length ? "Remove from this context (next note becomes Main)" : "Remove from this context").setIcon("unlink")
            .onClick(() => this.plugin.run(follower.changeGroup(key, { kind: "remove", path: note.path }))));
        return menu;
    }

    private unattachedMenu(note: NoteRowModel): Menu {
        const menu = new Menu();
        menu.addItem(item => item.setTitle("Open note").setIcon("file-text").onClick(() => this.plugin.openNotePath(note.path)));
        menu.addItem(item => item.setTitle("Attach to current context").setIcon("plus").setDisabled(!this.plugin.attachTarget(note.path))
            .onClick(() => this.plugin.run(this.plugin.follower.addCurrentNote(note.path))));
        menu.addItem(item => item.setTitle("Attach to another context…").setIcon("link-2").onClick(() => this.plugin.attachToAnotherContext(note.path)));
        return menu;
    }

    private groupMenu(group: GroupModel): Menu {
        const menu = new Menu(); const follower = this.plugin.follower; const key = group.key;
        menu.addItem(item => item.setTitle("Rename context…").setIcon("pencil").onClick(() => this.renameGroup(group)));
        menu.addItem(item => item.setTitle("Change icon…").setIcon("smile").onClick(() => this.plugin.chooseIcon(key)));
        menu.addItem(item => item.setTitle("Restore default name and icon").setIcon("rotate-ccw").setDisabled(!group.customTitle && !group.customIcon)
            .onClick(() => this.plugin.run(follower.changeGroup(key, { kind: "restore" }))));
        menu.addSeparator();
        menu.addItem(item => item.setTitle("Attach existing note…").setIcon("file-plus").onClick(() => this.plugin.attachExistingNote(key)));
        const activeNote = this.app.workspace.getActiveFile();
        const stored = this.plugin.mappings.group(key);
        const already = !!activeNote && !!stored && [stored.mainNote, ...stored.relatedNotes].includes(activeNote.path);
        menu.addItem(item => item.setTitle("Attach current note here").setIcon("plus").setDisabled(!activeNote || activeNote.extension !== "md" || already)
            .onClick(() => this.plugin.run(follower.changeGroup(key, { kind: "add", path: activeNote!.path }))));
        if (stored?.navigation) menu.addItem(item => item.setTitle("Open attached context").setIcon("external-link").onClick(() => this.plugin.openAttachment(key)));
        menu.addSeparator();
        menu.addItem(item => item.setTitle(group.expanded ? "Collapse" : "Expand").setIcon(group.expanded ? "chevron-right" : "chevron-down").onClick(() => this.plugin.toggleGroup(key, !group.expanded)));
        menu.addItem(item => item.setTitle("Remove all notes from this context").setIcon("unlink")
            .onClick(() => this.plugin.run(follower.changeGroup(key, { kind: "detach" }))));
        return menu;
    }

    private renameGroup(group: GroupModel): void {
        const modal = new Modal(this.app); modal.titleEl.setText("Rename context");
        modal.contentEl.createEl("p", { text: "Changes the display name only. The file, app, window or page this context follows is not affected.", cls: "setting-item-description" });
        const input = modal.contentEl.createEl("input", { type: "text", attr: { maxlength: "200", "aria-label": "Context name" } });
        input.value = group.title;
        const save = modal.contentEl.createEl("button", { text: "Save name", cls: "mod-cta" });
        save.onclick = () => { if (!input.value.trim()) return; modal.close(); void this.plugin.run(this.plugin.follower.changeGroup(group.key, { kind: "header", header: { mode: "custom", label: input.value } })); };
        input.onkeydown = event => { if (event.key === "Enter") save.click(); };
        modal.open(); input.focus(); input.select();
    }
}
