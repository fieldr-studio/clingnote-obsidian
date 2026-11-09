import { MarkdownView, Menu, Modal, Notice, Plugin, TFile, setIcon, setTooltip, type WorkspaceLeaf } from "obsidian";
import { loopbackGet, loopbackRequest } from "./transport";
import { LicenseClient, LicenseController, NOTICE_TEXT, nextLicenseNotice } from "./license";
import { discoverEndpoint } from "./discovery";
import { attachExplanation, panelContext, compactStatus, describeContext, endpointLocation, safeTarget } from "./presentation";
import { ContextClient, type HttpGet, type ReadEndpoint } from "./client";
import { ContextFollower, type NoteHost } from "./follower";
import { MappingStore } from "./mappings";
import { ClingNoteSettingTab } from "./settings";
import { DEFAULT_SETTINGS, type ClingNoteSettings, type Endpoint } from "./types";
import { startContextDiagnostics, traceContext } from "./diagnostics";
import { persistedData } from "./validation";
import { reconcilePause } from "./pause";
import { openStoredAttachment, type NavigationShell } from "./navigation";
import { activityLabel, freshActivity, quickActivity } from "./activity";
import type { PauseState } from "./types";
import { openLeftPanel } from "./panel-placement";
import { ContextGroupView, GROUP_VIEW } from "./group-view";
import { saveGroupMigration } from "./migration";
import { attachmentTarget, contextAccess } from "./context-policy";
import { StatusPresentation } from "./status-presentation";
import { AccentModal, AttachedContextsModal, ContextSuggestModal, IconPickerModal, NoteSuggestModal } from "./sidebar-modals";
import { contextTitle, DEFAULT_UI, pruneUi, setAllGroups, shouldActivateSidebar, toggleGroup, type IconRef } from "./sidebar-model";
import { accentColors, normalizeAccent } from "./accent";
import type { ContextGroup } from "./types";
import { members } from "./mappings";
import type { SidebarUiState } from "./types";

// Survives plugin disable/re-enable in this renderer; a restarted Obsidian renderer gets a new session.
const sessionHost = globalThis as typeof globalThis & { clingnotePauseSession?: string };
const pauseSession = sessionHost.clingnotePauseSession ??= `${process.pid}:${Date.now()}:${Math.random()}`;

export default class ClingNotePlugin extends Plugin {
	settings: ClingNoteSettings = { ...DEFAULT_SETTINGS };
	mappings = new MappingStore();
	follower!: ContextFollower;
	license!: LicenseController;
	private statusBar: HTMLElement | null = null;
	private unloaded = false;
	private saves: Promise<void> = Promise.resolve();
	private noteActions = new Map<MarkdownView, HTMLElement>();
	private settingTab!: ClingNoteSettingTab;
	private refreshSurfaces = new Set<() => void>();
	private pauseTimer?: ReturnType<typeof setTimeout>;
    private statusTimer?: ReturnType<typeof setTimeout>;
    private statusPresentation = new StatusPresentation();

	async onload(): Promise<void> {
		let data: ReturnType<typeof persistedData>;
		let original: unknown;
		try { original = await this.loadData(); data = persistedData(original); }
		catch {
			new Notice("ClingNote: settings or attachments could not be read. Existing data was preserved. Restore a valid data.json backup, then reload the plugin.", 12000);
			return; // No following, controls, or saves may overwrite unreadable user data.
		}
		this.settings = data.settings;
		this.mappings = new MappingStore(data.mappings as never);
        if (data.mappings?.version === 1) {
            try {
                const directory = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
                await saveGroupMigration(original, { settings: this.settings, mappings: this.mappings.toJSON() }, directory, {
                    exists: path => this.app.vault.adapter.exists(path),
                    write: (path, contents) => this.app.vault.adapter.write(path, contents),
                    save: next => this.saveData(next),
                });
            } catch {
                new Notice("ClingNote: attachment upgrade could not be saved safely. Following is stopped; check vault access and reload. The v1 backup is retained if created.", 12000);
                return;
            }
        }
        if (reconcilePause(this.settings, Date.now(), pauseSession)) await this.persist();

		this.license = new LicenseController(new LicenseClient(this.readEndpoint, loopbackRequest), changed => {
			this.updateStatusBar();
			if (changed) void this.follower?.refresh(); // entitlement just changed: re-evaluate the current context
			void this.showLicenseNotice();
		});
		const client = new ContextClient(this.readEndpoint, this.httpGet);
		this.follower = new ContextFollower(client, this.mappings, this.createHost(), () => this.settings.followEnabled, {
			limited: () => !this.license.entitled(),
			onStatus: status => {
				if (status === "connected") void this.license.refreshStatus();
				else if (status === "disconnected") this.license.clear();
				this.updateStatusBar();
			},
			onContext: () => this.updateStatusBar(),
			onMappingsChanged: () => {
				void this.persist();
				this.updateStatusBar();
			},
		});

		this.settingTab = new ClingNoteSettingTab(this.app, this);
        this.registerInterval(window.setInterval(() => void this.checkPause(), 60_000));
        this.registerInterval(window.setInterval(() => { if (this.follower.status === "connected") void this.license.refreshStatus(); }, 300_000));
        this.schedulePause();
		this.addSettingTab(this.settingTab);
        this.registerView(GROUP_VIEW, leaf => new ContextGroupView(leaf, this));
        this.addCommand({ id: "trace-context", name: "Start temporary context diagnostics (2 minutes)",
            callback: () => { startContextDiagnostics(); new Notice("ClingNote: privacy-safe context diagnostics enabled in the developer console for 2 minutes."); } });
		this.applyStatusBarSetting();
		this.addRibbonIcon("link", "ClingNote: Open panel", () => void this.openGroups());
        this.addCommand({ id: "open-context-groups", name: "Open ClingNote panel", callback: () => void this.openGroups() });
        this.addCommand({ id: "add-related-note", name: "Attach this note", checkCallback: checking => {
            const path = this.app.workspace.getActiveFile()?.path;
            if (!this.attachTarget(path)) return false;
            if (!checking) void this.run(this.follower.addCurrentNote(path));
            return true;
        } });
        this.addCommand({ id: "remove-group-note", name: "Detach this note", callback: () => void this.run(this.follower.removeCurrentNote()) });
		this.registerEvent(this.app.workspace.on("css-change", () => this.applyAccent()));
		this.registerEvent(this.app.workspace.on("layout-change", () => this.updateNoteActions()));
		this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.updateNoteActions()));
		this.registerEvent(this.app.workspace.on("file-open", () => this.updateNoteActions()));
		this.addCommand({ id: "open-current-note", name: "Open Main note", callback: () => void this.run(this.follower.openCurrentNote()) });
		this.addCommand({ id: "open-settings", name: "Settings", callback: () => this.openSettings() });
		this.addCommand({ id: "copy-follow-diagnostics", name: "Copy following diagnostics", callback: () => {
			const text = this.follower.diagnosticsText();
			console.debug(text);
			navigator.clipboard.writeText(text).then(() => new Notice("ClingNote: following diagnostics copied (no URLs, titles or paths)."),
				() => new Notice("ClingNote: could not copy; the diagnostics are in the developer console."));
		} });

		// Command ids must not repeat the plugin id; Obsidian prefixes it.
		this.addCommand({
			id: "attach-current-note",
			name: "Make this the Main note",
			checkCallback: (checking) => {
				if (!this.attachTarget(this.app.workspace.getActiveFile()?.path)) return false;
				if (!checking) void this.run(this.follower.attachCurrentNote());
				return true;
			},
		});
		this.addCommand({
			id: "detach-current-note",
			name: "Detach all notes from this context",
			checkCallback: checking => {
				const target = this.target();
				if (!target || !this.mappings.get(target.key)) return false;
				if (!checking) void this.run(this.follower.detachCurrentContext());
				return true;
			},
		});
		this.addCommand({
			id: "toggle-following",
			name: "Pause or resume following",
			callback: async () => {
				await this.setFollowing(!this.settings.followEnabled);
				new Notice(this.settings.followEnabled ? "ClingNote: following resumed." : "ClingNote: following paused.");
			},
		});
		this.addCommand({
			id: "show-status",
			name: "Show active Windows file and its note",
			callback: () => this.showDetails(),
		});

		// Vault lifecycle events update membership only; deleting Main promotes the first Attached note.
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				if (this.mappings.renameNote(oldPath, file.path) > 0) { void this.persist(); this.updateStatusBar(); }
			}),
		);
		this.registerEvent(this.app.vault.on("delete", file => {
			if (this.mappings.deleteNote(file.path) > 0) { void this.persist(); this.updateStatusBar(); }
		}));
		// File Explorer / tab menus: manage relationships from the note side without leaving the note.
		this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {
			if (!(file instanceof TFile) || file.extension !== "md") return;
			const count = this.mappings.keysForNote(file.path).length;
			menu.addItem(item => item.setTitle(count ? `ClingNote: attached to ${count} context${count === 1 ? "" : "s"}…` : "ClingNote: not attached…").setIcon("link-2").onClick(() => this.showAttachedContexts(file.path)));
			menu.addItem(item => item.setTitle("ClingNote: attach to another context…").setIcon("plus").onClick(() => this.attachToAnotherContext(file.path)));
		}));
		this.addCommand({ id: "reveal-active-context", name: "Show the active context in the sidebar", callback: () => {
			const key = contextAccess(this.follower.status, this.follower.lastState).accepted?.key;
			if (key && this.mappings.group(key)) void this.revealContext(key); else new Notice("ClingNote: the current context has no attached notes yet.");
		} });
		this.addCommand({ id: "attached-contexts", name: "View contexts this note is attached to", checkCallback: checking => {
			const path = this.app.workspace.getActiveFile()?.path;
			if (!path || !path.toLowerCase().endsWith(".md")) return false;
			if (!checking) this.showAttachedContexts(path);
			return true;
		} });

		this.app.workspace.onLayoutReady(() => {
			if (!this.unloaded) {
				this.updateNoteActions();
				this.applyAccent();
				void this.activateSidebarOnce(data.firstRun);
				void openLeftPanel(this.app.workspace, GROUP_VIEW, false).catch(() => new Notice("ClingNote: could not move the panel. Use Open ClingNote panel to retry."));
				void this.follower.run();
				if (data.firstRun) this.openSettings();
				if (data.firstRun) new Notice("ClingNote: attach once, then your note follows automatically. Click the link icon on a note to get started.", 10000);
			}
		});
	}

	onunload(): void {
		this.unloaded = true;
		this.clearAccent();
		this.follower?.stop();
		for (const action of this.noteActions.values()) action.remove();
		this.noteActions.clear();
		this.refreshSurfaces.clear();
        if (this.pauseTimer) clearTimeout(this.pauseTimer);
        if (this.statusTimer) clearTimeout(this.statusTimer);
	}

	/** At most one restrained, once-only notice (welcome, 3 days left, expired). Nothing for active Pro. */
	private async showLicenseNotice(): Promise<void> {
		if (this.unloaded) return;
		const kind = nextLicenseNotice(this.license.status, this.settings.licenseNotices ?? {});
		if (!kind) return;
		this.settings.licenseNotices = { ...this.settings.licenseNotices, [kind]: true };
		await this.persist();
		new Notice(NOTICE_TEXT[kind], 10000);
	}

	async setFollowing(enabled: boolean): Promise<void> {
		this.settings.followEnabled = enabled;
        if (enabled) delete this.settings.pause;
        else this.settings.pause = { kind: "indefinite" };
        this.schedulePause();
		await this.persist();
		this.updateStatusBar();
		if (enabled) await this.follower.refresh();
	}

    async pauseFollowing(pause: PauseState): Promise<void> {
        this.settings.followEnabled = false;
        this.settings.pause = pause;
        this.schedulePause(); await this.persist(); this.updateStatusBar();
    }
    private schedulePause(): void {
        if (this.pauseTimer) clearTimeout(this.pauseTimer);
        if (!this.settings.followEnabled && this.settings.pause?.kind === "timed")
            this.pauseTimer = setTimeout(() => void this.checkPause(), Math.max(1, Math.min(3600000, this.settings.pause.until - Date.now())));
    }
    private async checkPause(): Promise<void> {
        if (this.unloaded) return;
        if (reconcilePause(this.settings, Date.now(), pauseSession)) {
            await this.persist();
            if (!this.unloaded) await this.follower.refresh();
        }
        this.schedulePause(); this.updateStatusBar();
    }
    showPauseOptions(): void {
        const modal = new Modal(this.app); modal.titleEl.setText("Pause following");
        for (const minutes of [15, 30, 60]) {
            const button = modal.contentEl.createEl("button", { text: minutes === 60 ? "1 hour" : `${minutes} minutes`, cls: "clingnote-pause-option" });
            button.onclick = () => { modal.close(); void this.pauseFollowing({ kind: "timed", until: Date.now() + minutes * 60000 }); };
        }
        for (const [label, pause] of [["Until Obsidian restarts", { kind: "restart", session: pauseSession }], ["Until I resume", { kind: "indefinite" }]] as const) {
            const button = modal.contentEl.createEl("button", { text: label, cls: "clingnote-pause-option" });
            button.onclick = () => { modal.close(); void this.pauseFollowing(pause); };
        }
        modal.open();
    }

	/** Sidebar presentation state (expand/collapse, sort). Presentation only; safe to lose. */
	ui(): SidebarUiState { return this.settings.ui ?? DEFAULT_UI; }
	private async updateUi(next: SidebarUiState): Promise<void> {
		this.settings.ui = pruneUi(next, this.mappings.groupEntries().map(([key]) => key));
		await this.persist(); this.updateStatusBar();
	}
	toggleGroup(key: string, expanded: boolean): void { void this.updateUi(toggleGroup(this.ui(), key, expanded)); }
	setAllExpanded(keys: string[], expanded: boolean): void { void this.updateUi(setAllGroups(this.ui(), keys, expanded)); }
	setSort(sort: "created" | "name"): void { void this.updateUi({ ...this.ui(), sort }); }
	setUnattachedExpanded(expanded: boolean): void { void this.updateUi({ ...this.ui(), unattachedExpanded: expanded }); }

	/** Display name of a saved context (custom name or its own label). */
	contextName(group: ContextGroup): string { return contextTitle(group).title; }
	notify(message: string): void { new Notice(`ClingNote: ${message}`); }

	/**
	 * First successful launch: make ClingNote the selected left tab once. An existing user's saved layout or saved contexts are
	 * respected, and after this decision is recorded a deliberate switch to File Explorer is never overridden.
	 */
	async activateSidebarOnce(firstRun: boolean): Promise<void> {
		if (this.unloaded || this.ui().sidebarActivated) return;
		const viewExists = this.app.workspace.getLeavesOfType(GROUP_VIEW).length > 0;
		const activate = shouldActivateSidebar({ alreadyActivated: false, firstRun, viewExists, hasSavedContexts: this.mappings.groupEntries().length > 0 });
		try { if (activate) await openLeftPanel(this.app.workspace, GROUP_VIEW, true); }
		catch { new Notice("ClingNote: could not select the panel. Use Open ClingNote panel."); }
		await this.updateUi({ ...this.ui(), sidebarActivated: true });
	}

	/** Accent preference: CSS variables used only by ClingNote's own elements, never Obsidian's theme or other plugins. */
	applyAccent(preview?: string | null): void {
		const accent = preview === undefined ? normalizeAccent(this.ui().accent) : preview ?? undefined;
		if (!accent) { this.clearAccent(); return; }
		const colors = accentColors(accent, document.body.classList.contains("theme-dark"));
		const style = document.body.style;
		style.setProperty("--clingnote-accent", colors.fill);
		style.setProperty("--clingnote-accent-text", colors.text);
		style.setProperty("--clingnote-on-accent", colors.onFill);
	}
	private clearAccent(): void {
		for (const name of ["--clingnote-accent", "--clingnote-accent-text", "--clingnote-on-accent"]) document.body.style.removeProperty(name);
	}
	async setAccent(accent: string | undefined): Promise<void> {
		const { accent: _old, ...rest } = this.ui();
		await this.updateUi(accent ? { ...rest, accent: normalizeAccent(accent) } : rest);
		this.applyAccent();
	}
	chooseAccent(): void { new AccentModal(this.app, this).open(); }

	moveToAnotherContext(fromKey: string, path: string): void {
		const choices = this.mappings.groupEntries().filter(([key, group]) => key !== fromKey && ![group.mainNote, ...group.relatedNotes].includes(path))
			.map(([key, group]) => ({ key, title: contextTitle(group).title }));
		if (!choices.length) { new Notice("ClingNote: no other context to move this note to."); return; }
		new ContextSuggestModal(this.app, choices, to => void this.run(this.follower.changeGroup(fromKey, { kind: "moveTo", path, to })), "Move to which context? (removed from this one)").open();
	}

	paintIcon(el: HTMLElement, icon: IconRef): void {
		el.empty();
		if (icon.kind === "emoji") { el.setText(icon.value); el.addClass("is-emoji"); } else { el.removeClass("is-emoji"); setIcon(el, icon.value); }
	}

	/** Open a note with Obsidian's own navigation: reuse its tab if it is already open. */
	openNotePath(path: string): void {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) { new Notice("ClingNote: that note no longer exists."); return; }
		const open = this.app.workspace.getLeavesOfType("markdown").find(leaf => leaf.view instanceof MarkdownView && leaf.view.file?.path === path);
		if (open) this.app.workspace.setActiveLeaf(open, { focus: true });
		else void this.app.workspace.getLeaf(false).openFile(file);
	}

	/** Bring the sidebar forward with this context expanded and in view; optionally open its Main note. */
	async revealContext(key: string, openMain = false): Promise<void> {
		await this.openGroups();
		for (const leaf of this.app.workspace.getLeavesOfType(GROUP_VIEW)) if (leaf.view instanceof ContextGroupView) leaf.view.reveal(key);
		const main = this.mappings.group(key)?.mainNote;
		if (openMain && main) this.openNotePath(main);
	}

	showAttachedContexts(path: string): void { new AttachedContextsModal(this.app, this, path).open(); }

	attachToAnotherContext(path: string): void {
		const choices = this.mappings.groupEntries().filter(([, group]) => !members(group).includes(path))
			.map(([key, group]) => ({ key, title: contextTitle(group).title }));
		if (!choices.length) { new Notice("ClingNote: no other context to attach to. Switch to a file, app or page and use + to create one."); return; }
		new ContextSuggestModal(this.app, choices, key => void this.run(this.follower.changeGroup(key, { kind: "add", path }))).open();
	}

	attachExistingNote(key: string): void {
		const group = this.mappings.group(key);
		if (!group) return;
		const present = new Set(members(group));
		const candidates = this.app.vault.getMarkdownFiles().filter(file => !present.has(file.path));
		if (!candidates.length) { new Notice("ClingNote: every note is already attached to this context."); return; }
		new NoteSuggestModal(this.app, candidates, path => void this.run(this.follower.changeGroup(key, { kind: "add", path }))).open();
	}

	chooseIcon(key: string): void { new IconPickerModal(this.app, this, key).open(); }

	async persist(): Promise<void> {
		const data = JSON.parse(JSON.stringify({ settings: this.settings, mappings: this.mappings.toJSON() }));
		this.saves = this.saves.then(() => this.saveData(data)).catch(() => {
			new Notice("ClingNote: could not save settings/attachments. Check vault access before restarting.");
		});
		await this.saves;
	}

	async setEndpointFile(value: string): Promise<void> {
		this.settings.endpointFile = value;
		await this.persist();
		await this.follower.reconnect();
	}

	applyStatusBarSetting(): void {
		if (this.settings.showStatusBar && !this.statusBar) {
			this.statusBar = this.addStatusBarItem();
			this.statusBar.addClass("clingnote-status");
			this.statusBar.setAttribute("role", "button");
			this.statusBar.tabIndex = 0;
			this.registerDomEvent(this.statusBar, "click", event => this.showMenu(event));
			this.registerDomEvent(this.statusBar, "keydown", event => {
				if (event.key === "Enter" || event.key === " ") { event.preventDefault(); this.showMenu(); }
			});
		}
		if (!this.settings.showStatusBar && this.statusBar) {
			this.statusBar.remove();
			this.statusBar = null;
		}
		this.updateStatusBar();
	}

	updateStatusBar(): void {
        if (this.unloaded) return;
        this.updateNoteActions();
        for (const refresh of this.refreshSurfaces) refresh();
        const current = this.follower ? contextAccess(this.follower.status, this.follower.lastState).accepted : null;
        const display = this.statusPresentation.read(this.follower?.status ?? "connecting", this.follower?.lastState ?? null,
            this.settings.followEnabled, !!current && !!this.mappings.get(current.key), this.settings.showUnmappedHint);
        const text = display.text;
        if (this.statusTimer) clearTimeout(this.statusTimer);
        this.statusTimer = display.refreshAfterMs === undefined ? undefined : setTimeout(() => this.updateStatusBar(), display.refreshAfterMs);
        if (this.statusBar && this.statusBar.textContent !== text) this.statusBar.setText(text);
        if (this.statusBar) setTooltip(this.statusBar, "ClingNote actions: attach, open, pause, and settings");
        traceContext("status-render", this.follower?.lastState ?? null, {
            statusKey: this.follower?.lastState?.current?.key, renderedText: text });
	}

	async run(action: Promise<{ ok: boolean; message: string }>): Promise<void> {
		try { const result = await action; new Notice(`ClingNote: ${result.message}`); }
		catch { new Notice("ClingNote: the command failed. Check connection and vault access."); }
	}

	private readonly readEndpoint: ReadEndpoint = async (): Promise<Endpoint | null> => {
		if (process.platform !== "win32") return null;
        return discoverEndpoint(this.settings.endpointFile, process.env.LOCALAPPDATA);
	};

	endpointPath(): string | null { return endpointLocation(this.settings.endpointFile, process.env.LOCALAPPDATA); }
	target() { return safeTarget(this.follower.status, this.follower.lastState); }
    attachTarget(notePath?: string) { return attachmentTarget(this.follower.status, this.follower.lastState, notePath); }
	onSurfaceRefresh(callback: () => void): () => void { this.refreshSurfaces.add(callback); return () => this.refreshSurfaces.delete(callback); }

	async removeAttachment(key: string): Promise<void> {
        if (!await this.follower.confirmNormalContext()) { new Notice("ClingNote: connect to a non-private context first."); return; }
		this.mappings.detach(key);
		await this.persist();
		this.updateStatusBar();
	}

    async undoActivity(id: number): Promise<void> {
        if (!await this.follower.confirmNormalContext()) { new Notice("ClingNote: connect to a non-private context first."); return; }
        const ok = this.mappings.undo(id, path => this.app.vault.getAbstractFileByPath(path) instanceof TFile);
        if (ok) { await this.persist(); this.updateStatusBar(); }
        new Notice(ok ? "ClingNote: attachment action undone. Notes were not changed." : "ClingNote: cannot undo safely; the attachment or note has changed.");
    }
    async openAttachment(key: string, reveal = false): Promise<void> {
        const target = this.mappings.get(key)?.navigation;
        try {
            const message = await openStoredAttachment(target, reveal, (require("electron") as { shell: NavigationShell }).shell);
            if (message) new Notice(`ClingNote: ${message}`);
        } catch { new Notice("ClingNote: could not open the attached context."); }
    }

	private updateNoteActions(): void {
		if (!this.follower || this.unloaded) return;
		const views = new Set(this.app.workspace.getLeavesOfType("markdown").map(leaf => leaf.view).filter((view): view is MarkdownView => view instanceof MarkdownView));
		for (const [view, action] of this.noteActions) if (!views.has(view)) { action.remove(); this.noteActions.delete(view); }
		for (const view of views) {
			let action = this.noteActions.get(view);
			if (!action) { action = view.addAction("link", "ClingNote", event => this.showMenu(event, view.file?.path)); this.noteActions.set(view, action); }
			const keys = view.file ? this.mappings.keysForNote(view.file.path) : [];
			const label = keys.length > 1 ? `Attached to ${keys.length} contexts` : keys.length ? `Attached to ${this.mappings.get(keys[0])?.label || "saved context"}` : "This note is not attached";
			setTooltip(action, `ClingNote: ${label}`);
			action.setAttribute("aria-label", `ClingNote: ${label}`);
			action.toggleClass("clingnote-attached", keys.length > 0);
		}
	}

	showMenu(event?: MouseEvent, notePath = this.app.workspace.getActiveFile()?.path): void {
		const menu = new Menu();
		const target = this.target();
		const mapping = target ? this.mappings.get(target.key) : undefined;
        const reason = attachExplanation(this.follower.status, this.follower.lastState, notePath);
        if (reason) menu.addItem(item => item.setTitle(reason).setDisabled(true));
        else if (!mapping) menu.addItem(item => item.setTitle("No notes attached to this context yet").setDisabled(true));
        else if (notePath && !this.mappings.keysForNote(notePath).includes(target!.key))
            menu.addItem(item => item.setTitle("This note is not attached to the current context").setDisabled(true));
		menu.addItem(item => item.setTitle("Make this the Main note").setIcon("star").setDisabled(!this.attachTarget(notePath)).onClick(() => this.run(this.follower.attachCurrentNote(notePath))));
        menu.addItem(item => item.setTitle("Attach this note").setIcon("plus").setDisabled(!this.attachTarget(notePath)).onClick(() => this.run(this.follower.addCurrentNote(notePath))));
        menu.addItem(item => item.setTitle("Detach this note").setIcon("minus").setDisabled(!target || !notePath || !this.mappings.keysForNote(notePath).includes(target.key)).onClick(() => this.run(this.follower.removeCurrentNote(notePath))));
        if (notePath) {
            menu.addItem(item => item.setTitle("View attached contexts").setIcon("link-2").onClick(() => this.showAttachedContexts(notePath)));
            menu.addItem(item => item.setTitle("Attach to another context…").setIcon("plus").onClick(() => this.attachToAnotherContext(notePath)));
        }
        menu.addItem(item => item.setTitle("Open ClingNote panel").setIcon("list").onClick(() => this.openGroups()));
		menu.addItem(item => item.setTitle("Open Main note").setIcon("file-text").setDisabled(!target || !mapping).onClick(() => this.run(this.follower.openCurrentNote())));
		menu.addItem(item => item.setTitle("Detach all notes from this context").setIcon("unlink").setDisabled(!target || !mapping).onClick(() => this.run(this.follower.detachCurrentContext())));
		menu.addItem(item => item.setTitle("View attachment details").setIcon("info").onClick(() => this.showDetails(notePath)));
        menu.addItem(item => {
            item.setTitle("Recent activity").setIcon("history");
            // Obsidian's native submenu exists on desktop but is not in the public typings.
            // Feature-detect it; older hosts open the same compact menu on click.
            const native = item as typeof item & { setSubmenu?: () => Menu };
            if (native.setSubmenu) this.populateRecentMenu(native.setSubmenu());
            else item.onClick(() => { const recent = new Menu(); this.populateRecentMenu(recent); recent.showAtPosition({ x: event?.clientX ?? 100, y: event?.clientY ?? 100 }); });
        });
		menu.addSeparator();
		menu.addItem(item => item.setTitle(this.settings.followEnabled ? "Pause following…" : "Resume following").setIcon(this.settings.followEnabled ? "pause" : "play").onClick(() => this.settings.followEnabled ? this.showPauseOptions() : this.setFollowing(true)));
		if (this.follower.status !== "connected") menu.addItem(item => item.setTitle("Retry connection").setIcon("refresh-cw").onClick(() => this.follower.reconnect().then(() => undefined)));
		menu.addItem(item => item.setTitle("Settings").setIcon("settings").onClick(() => this.openSettings()));
		if (event) menu.showAtMouseEvent(event);
		else { const rect = this.statusBar?.getBoundingClientRect(); menu.showAtPosition({ x: rect?.left ?? 100, y: rect?.top ?? 100 }); }
	}

    private populateRecentMenu(menu: Menu): void {
        if (this.follower.lastState?.pauseReason) menu.addItem(item => item.setTitle("Unavailable during privacy pause").setDisabled(true));
        else {
            const recent = quickActivity(this.mappings.recent());
            if (!recent.length) menu.addItem(item => item.setTitle("No recent attachment actions").setDisabled(true));
            for (const action of recent) menu.addItem(item => item.setTitle(activityLabel(action))
                .setDisabled(!freshActivity(action)).onClick(() => this.showActivityUndo(action.id)));
        }
        menu.addSeparator();
        menu.addItem(item => item.setTitle("View all…").onClick(() => this.openSettings(true)));
    }
    private showActivityUndo(id: number): void {
        const action = this.mappings.recent().find(item => item.id === id);
        if (!action || this.follower.lastState?.pauseReason) return;
        const modal = new Modal(this.app); modal.titleEl.setText("Recent activity");
        modal.contentEl.createEl("p", { text: activityLabel(action), cls: "clingnote-location" });
        const undo = modal.contentEl.createEl("button", { text: "Undo attachment change" });
        undo.disabled = !freshActivity(action);
        undo.onclick = () => { modal.close(); void this.undoActivity(id); };
        modal.open();
    }

	openSettings(recent = false): void {
		const modal = new Modal(this.app);
		modal.titleEl.setText("ClingNote");
		const tab = new ClingNoteSettingTab(this.app, this);
		tab.render(modal.contentEl);
		modal.onClose = () => tab.hide();
		modal.open();
        if (recent) modal.contentEl.querySelector(".clingnote-recent-activity")?.scrollIntoView({ block: "start" });
	}

    async openGroups(): Promise<void> {
        await openLeftPanel(this.app.workspace, GROUP_VIEW);
    }

	showDetails(notePath?: string): void {
		const modal = new Modal(this.app);
		modal.titleEl.setText("ClingNote attachment details");
		const render = () => {
			modal.contentEl.empty();
			this.renderContext(modal.contentEl);
            if (this.follower.lastState?.pauseReason) return;
			if (notePath) {
				modal.contentEl.createEl("h3", { text: "This note’s attachments" });
				const keys = this.mappings.keysForNote(notePath);
				if (!keys.length) modal.contentEl.createEl("p", { text: "Not attached yet. Attach once to bring this note back automatically." });
				for (const key of keys) {
					const row = modal.contentEl.createDiv({ cls: "clingnote-attachment" });
					row.createEl("p", { text: this.mappings.get(key)?.label || "Saved context" });
                    const navigation = this.mappings.get(key)?.navigation;
                    if (navigation) {
                        const open = row.createEl("button", { text: navigation.kind === "page" ? "Open page (HTTPS)" : navigation.kind === "folder" ? "Open folder" : "Open attached file" });
                        open.onclick = () => void this.openAttachment(key);
                        if (navigation.kind !== "page") {
                            const reveal = row.createEl("button", { text: "Show in File Explorer" });
                            reveal.onclick = () => void this.openAttachment(key, true);
                        }
                    } else row.createEl("p", { text: "Reverse navigation unavailable for this attachment.", cls: "setting-item-description" });
					const button = row.createEl("button", { text: "Detach this note" });
					button.disabled = !!this.follower.lastState?.pauseReason;
					button.onclick = () => void this.run(this.follower.changeGroup(key, { kind: "remove", path: notePath }));
				}
			}
		};
		render();
		const unsubscribe = this.onSurfaceRefresh(render);
		modal.onClose = unsubscribe;
		modal.open();
	}

	renderContext(container: HTMLElement): void {
        container.addClass("clingnote-context");
        const info = panelContext(this.follower.status, this.follower.lastState);
        container.createEl("p", { text: info.heading });
        if (info.title) container.createEl("p", { text: info.title });
        if (info.location) container.createEl("p", { text: info.location, cls: "clingnote-location" });
        if (info.detail) container.createEl("p", { text: info.detail, cls: "setting-item-description" });

	}

	private readonly httpGet: HttpGet = loopbackGet;

	private createHost(): NoteHost {
		const workspace = this.app.workspace;
		return {
			activeNotePath: () => workspace.getActiveFile()?.path ?? null,
			noteExists: (path) => this.app.vault.getAbstractFileByPath(path) instanceof TFile,
			notify: (message) => new Notice(message),
			openNote: async (path) => {
				const file = this.app.vault.getAbstractFileByPath(path);
				if (!(file instanceof TFile) || file.extension.toLowerCase() !== "md") return;
				let leaf: WorkspaceLeaf | undefined = workspace
					.getLeavesOfType("markdown")
					.find((candidate) => candidate.view instanceof MarkdownView && candidate.view.file?.path === path);
				if (!leaf) {
					leaf = workspace.getLeaf(false);
					await leaf.openFile(file, { active: false, eState: { focus: false } });
				}
				// Show it, but leave keyboard focus with the Windows app the user is working in.
				workspace.setActiveLeaf(leaf, { focus: false });
			},
		};
	}
}
