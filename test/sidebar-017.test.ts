import { test } from "node:test";
import assert from "node:assert/strict";
import { MappingStore, members, validIcon } from "../src/mappings";
import { persistedData } from "../src/validation";
import { contextAccess } from "../src/context-policy";
import { buildSidebarModel, contextTitle, DEFAULT_UI, modelSignature, pruneUi, setAllGroups, toggleGroup } from "../src/sidebar-model";
import type { ContextState, SidebarUiState } from "../src/types";
import { FakeHost, FakeService, makeFollower, snapshot } from "./helpers";

const CHROME = "url:example.com/research";
const EXCEL = "file-id:vol:1:excel";
const FOLDER = "file-id:vol:2:folder";
const VAULT = ["Research.md", "Tasks.md", "Ideas.md", "Budget.md", "Loose A.md", "loose b.md"];

function threeContexts() {
    const store = new MappingStore();
    // Chrome: Research (first attach => Main), Tasks, Ideas
    store.attach(CHROME, "Research.md", "Research page");
    store.addNote(CHROME, "Tasks.md", "Research page");
    store.addNote(CHROME, "Ideas.md", "Research page");
    // Excel and Explorer reference the SAME Research.md
    store.attach(EXCEL, "Budget.md", "Budget.xlsx");
    store.addNote(EXCEL, "Research.md", "Budget.xlsx");
    store.attach(FOLDER, "Research.md", "Projects folder");
    return store;
}
const model = (store: MappingStore, extra: Partial<Parameters<typeof buildSidebarModel>[0]> = {}) => buildSidebarModel({
    groups: store.groupEntries(), vaultNotes: VAULT, exists: () => true, ui: DEFAULT_UI, activeKey: null, ...extra,
});

test("0.17: one note belongs to many contexts and one context has many notes, without duplicates", () => {
    const store = threeContexts();
    assert.deepEqual(members(store.group(CHROME)!), ["Research.md", "Tasks.md", "Ideas.md"]);
    assert.deepEqual(store.contextsForNote("Research.md").map(c => c.key).sort(), [CHROME, EXCEL, FOLDER].sort());
    assert.equal(store.addNote(CHROME, "Research.md", "x"), false, "no duplicate association inside a context");
    assert.equal(store.group(CHROME)!.relatedNotes.filter(p => p === "Research.md").length, 0);
    // The reverse index and the forward groups describe the same relationships.
    for (const [key, group] of store.groupEntries()) for (const path of members(group))
        assert.ok(store.contextsForNote(path).some(c => c.key === key));
    for (const path of store.attachedPaths()) assert.ok(store.keysForNote(path).length >= 1);
});

test("0.17: Main is independent per context, with a sensible default for the first note", () => {
    const store = threeContexts();
    assert.equal(store.group(CHROME)!.mainNote, "Research.md", "first attached note becomes Main");
    assert.equal(store.group(EXCEL)!.mainNote, "Budget.md");
    assert.equal(store.makeMain(EXCEL, "Research.md"), true);
    assert.equal(store.group(EXCEL)!.mainNote, "Research.md");
    assert.equal(store.group(CHROME)!.mainNote, "Research.md");
    assert.equal(store.makeMain(CHROME, "Ideas.md"), true);
    // Research.md is Main in Excel and Explorer, secondary in Chrome.
    const roles = Object.fromEntries(store.contextsForNote("Research.md").map(c => [c.key, c.main]));
    assert.deepEqual(roles, { [CHROME]: false, [EXCEL]: true, [FOLDER]: true });
    for (const [, group] of store.groupEntries()) assert.ok(!group.relatedNotes.includes(group.mainNote), "exactly one Main per context");
});

test("0.17: unlinking changes only that association and never touches Markdown files", () => {
    const store = threeContexts();
    const host = new FakeHost(); VAULT.forEach(p => host.files.add(p));
    const before = new Set(host.files);
    assert.equal(store.removeNote(EXCEL, "Research.md"), true);
    assert.deepEqual(store.contextsForNote("Research.md").map(c => c.key).sort(), [CHROME, FOLDER].sort());
    assert.deepEqual(members(store.group(EXCEL)!), ["Budget.md"]);
    assert.deepEqual([...host.files], [...before], "association removal has no file side effects");
    // Removing the last note removes the context group, not the note.
    assert.equal(store.removeNote(FOLDER, "Research.md"), true);
    assert.equal(store.group(FOLDER), undefined);
    assert.ok(store.keysForNote("Research.md").includes(CHROME));
    // Unlinking the Main promotes the next attached note so the context keeps exactly one Main.
    assert.equal(store.removeNote(CHROME, "Research.md"), true);
    assert.equal(store.group(CHROME)!.mainNote, "Tasks.md");
});

test("0.17: rename, folder move and delete update every context that references the note", () => {
    const store = threeContexts();
    assert.ok(store.renameNote("Research.md", "Archive/Research 2.md") >= 3);
    assert.deepEqual(store.contextsForNote("Archive/Research 2.md").map(c => c.key).sort(), [CHROME, EXCEL, FOLDER].sort());
    assert.equal(store.contextsForNote("Research.md").length, 0);
    assert.ok(store.renameNote("Archive", "Moved") >= 3, "folder move rewrites all prefixed paths");
    assert.equal(store.group(CHROME)!.mainNote, "Moved/Research 2.md");
    store.deleteNote("Moved/Research 2.md");
    assert.equal(store.group(FOLDER), undefined, "context with only that note disappears");
    assert.equal(store.group(CHROME)!.mainNote, "Tasks.md");
    assert.deepEqual(members(store.group(EXCEL)!), ["Budget.md"]);
});

test("0.17: relationships and customization survive a restart (JSON round trip through the loader)", () => {
    const store = threeContexts();
    store.setHeader(CHROME, { mode: "custom", label: "Competitor research" });
    store.setIcon(CHROME, "lucide:microscope");
    store.setIcon(EXCEL, "emoji:📊");
    const ui: SidebarUiState = { collapsed: [EXCEL], unattachedExpanded: true, sort: "name" };
    const saved = JSON.parse(JSON.stringify({ settings: { followEnabled: true, ui }, mappings: store.toJSON() }));
    const loaded = persistedData(saved);
    const restored = new MappingStore(loaded.mappings as never);
    assert.deepEqual(restored.groupEntries(), store.groupEntries());
    assert.deepEqual(loaded.settings.ui, ui);
    assert.equal(restored.group(CHROME)!.icon, "lucide:microscope");
    assert.deepEqual(restored.group(CHROME)!.header, { mode: "custom", label: "Competitor research" });
    assert.equal(restored.group(EXCEL)!.icon, "emoji:📊");
});

test("0.17: 0.16 data (no icon, no ui) loads unchanged and saves in the same v2 format", () => {
    const legacy = { settings: { endpointFile: "C:\\x\\endpoint.json", followEnabled: true, showStatusBar: true, showUnmappedHint: true },
        mappings: { version: 2, groups: { [CHROME]: { mainNote: "Research.md", relatedNotes: ["Tasks.md"], label: "Research page", header: { mode: "context" } } }, activity: [] } };
    const frozen = JSON.stringify(legacy);
    const loaded = persistedData(legacy);
    assert.equal(JSON.stringify(legacy), frozen, "loading never mutates the stored object");
    assert.equal(loaded.settings.ui, undefined, "no ui block is invented until the user changes something");
    const store = new MappingStore(loaded.mappings as never);
    const out = store.toJSON();
    assert.equal(out.version, 2);
    assert.deepEqual(out.groups[CHROME], legacy.mappings.groups[CHROME], "no new fields appear on untouched groups");
});

test("0.17: customization changes only display data; identity key and followed resource are untouched", () => {
    const store = threeContexts();
    const keysBefore = store.groupEntries().map(([k]) => k);
    assert.equal(store.setHeader(CHROME, { mode: "custom", label: "My name" }), true);
    assert.equal(store.setIcon(CHROME, "lucide:globe"), true);
    assert.deepEqual(store.groupEntries().map(([k]) => k), keysBefore);
    assert.deepEqual(store.get(CHROME)?.navigation, undefined);
    assert.equal(contextTitle(store.group(CHROME)!).title, "My name");
    assert.equal(store.group(CHROME)!.label, "Research page", "stored context label is preserved under a custom name");
    assert.equal(store.setIcon(CHROME, "bogus"), false);
    assert.equal(store.setIcon(CHROME, "emoji:abc"), false, "ASCII text is not an emoji icon");
    assert.equal(validIcon("emoji:<b>😀"), false);
    assert.equal(store.restoreAppearance(CHROME), true);
    assert.equal(contextTitle(store.group(CHROME)!).title, "Research page");
    assert.equal(store.group(CHROME)!.icon, undefined);
    assert.equal(store.restoreAppearance(CHROME), false, "already default");
});

test("0.17: expansion state is persisted per context; automatic expansion is session-only", () => {
    const store = threeContexts();
    let ui = toggleGroup(DEFAULT_UI, EXCEL, false);
    assert.deepEqual(ui.collapsed, [EXCEL]);
    let m = model(store, { ui });
    assert.equal(m.groups.find(g => g.key === EXCEL)!.expanded, false);
    assert.equal(m.groups.find(g => g.key === CHROME)!.expanded, true, "unrelated groups are not collapsed");
    // The Windows context becomes Excel: expanded for this session without rewriting the saved preference.
    m = model(store, { ui, activeKey: EXCEL, transientExpanded: new Set([EXCEL]) });
    assert.equal(m.groups.find(g => g.key === EXCEL)!.expanded, true);
    assert.deepEqual(ui.collapsed, [EXCEL], "persisted preference is still collapsed");
    ui = toggleGroup(ui, EXCEL, true);
    assert.deepEqual(ui.collapsed, []);
    assert.deepEqual(setAllGroups(ui, [CHROME, EXCEL], false).collapsed, [CHROME, EXCEL]);
    assert.deepEqual(pruneUi({ ...ui, collapsed: [CHROME, "url:gone"] }, [CHROME]).collapsed, [CHROME]);
    const reloaded = persistedData(JSON.parse(JSON.stringify({ settings: { ui: { collapsed: [EXCEL], unattachedExpanded: true, sort: "created" } } })));
    assert.deepEqual(reloaded.settings.ui, { collapsed: [EXCEL], unattachedExpanded: true, sort: "created" });
    assert.deepEqual(persistedData({ settings: { ui: { collapsed: [1, null, "ok"], sort: "weird" } } }).settings.ui,
        { collapsed: ["ok"], unattachedExpanded: false, sort: "created" }, "damaged presentation state is sanitized, not fatal");
});

test("0.17: Main is listed first and secondary notes follow; unattached classification tracks associations", () => {
    const store = threeContexts();
    store.makeMain(CHROME, "Ideas.md");
    let m = model(store);
    const chrome = m.groups.find(g => g.key === CHROME)!;
    assert.deepEqual(chrome.notes.map(n => [n.name, n.main]), [["Ideas", true], ["Research", false], ["Tasks", false]]);
    assert.equal(chrome.notes.find(n => n.name === "Research")!.contextCount, 3);
    assert.deepEqual(m.unattached.notes.map(n => n.path), ["Loose A.md", "loose b.md"]);
    store.addNote(CHROME, "Loose A.md", "Research page");
    m = model(store);
    assert.deepEqual(m.unattached.notes.map(n => n.path), ["loose b.md"], "attached note leaves Unattached");
    store.removeNote(CHROME, "Loose A.md");
    m = model(store);
    assert.deepEqual(m.unattached.notes.map(n => n.path), ["Loose A.md", "loose b.md"], "fully unattached again");
    store.detach(FOLDER); // Research.md is still attached elsewhere
    assert.ok(!model(store).unattached.notes.some(n => n.path === "Research.md"));
    assert.equal(model(store).unattached.expanded, false, "Unattached starts collapsed");
});

test("0.17: search finds contexts, attached notes and unattached notes without creating anything", () => {
    const store = threeContexts();
    store.setHeader(EXCEL, { mode: "custom", label: "Quarterly budget" });
    const before = JSON.stringify(store.toJSON());
    let m = model(store, { query: "quarterly" });
    assert.deepEqual(m.groups.map(g => g.key), [EXCEL]);
    assert.equal(m.groups[0].notes.length, 2, "a context-name match shows all of its notes");
    m = model(store, { query: "tasks" });
    assert.deepEqual(m.groups.map(g => g.key), [CHROME]);
    assert.deepEqual(m.groups[0].notes.map(n => n.name), ["Tasks"], "a note match shows only matching notes");
    assert.equal(m.groups[0].expanded, true, "results are expanded even if collapsed");
    m = model(store, { query: "LOOSE" });
    assert.equal(m.groups.length, 0);
    assert.deepEqual(m.unattached.notes.map(n => n.path), ["Loose A.md", "loose b.md"]);
    assert.equal(m.unattached.expanded, true);
    m = model(store, { query: "research" });
    assert.ok(m.groups.length === 3, "Research.md appears under each context that owns it (same file)");
    assert.equal(model(store, { query: "zzz" }).noMatches, true);
    assert.equal(JSON.stringify(store.toJSON()), before, "searching is read-only");
});

test("0.17: the active Windows context highlights its group and Main note; others stay as they were", () => {
    const store = threeContexts();
    const service = new FakeService();
    const target = { ...snapshot("chrome.exe", "Research page"), key: CHROME };
    const state: ContextState = { seq: 1, current: target, lastExternal: target, pauseReason: null, pauseDetail: null,
        acceptedTarget: target, availability: "ready" };
    const access = contextAccess("connected", state);
    assert.equal(access.target?.key, CHROME);
    const m = model(store, { activeKey: access.accepted?.key ?? null });
    assert.deepEqual(m.groups.filter(g => g.active).map(g => g.key), [CHROME]);
    assert.equal(m.groups.find(g => g.active)!.notes.find(n => n.main)!.path, "Research.md");
    assert.equal(modelSignature(m), modelSignature(model(store)), "highlight is not part of the structure");
    assert.equal(modelSignature(m), modelSignature(model(store, { activeKey: EXCEL })), "highlight alone does not force a DOM rebuild");
    void service;
});

test("0.17: private browsing blocks attaching and every relationship change", async () => {
    const service = new FakeService();
    const host = new FakeHost(); host.files.add("Research.md"); host.files.add("Tasks.md"); host.active = "Tasks.md";
    const { follower, mappings } = makeFollower(service, host);
    mappings.attach(CHROME, "Research.md", "Research page");
    service.state = { seq: 5, current: null, lastExternal: null, pauseReason: "private-browsing", pauseDetail: "confirmed-private",
        acceptedTarget: null, availability: "private" };
    await follower.step();
    assert.equal((await follower.attachCurrentNote("Tasks.md")).ok, false);
    assert.equal((await follower.addCurrentNote("Tasks.md")).ok, false);
    for (const change of [{ kind: "add", path: "Tasks.md" }, { kind: "insert", path: "Tasks.md" },
        { kind: "remove", path: "Research.md" }, { kind: "detach" }] as const) {
        const result = await follower.changeGroup(CHROME, change);
        assert.equal(result.ok, false, `${change.kind} blocked while private`);
    }
    assert.deepEqual(members(mappings.group(CHROME)!), ["Research.md"], "nothing changed");
    // An unverified/ambiguous browser state also refuses to attach.
    service.state = { ...service.state, seq: 6, availability: "privacy-unknown", pauseDetail: "verifying-context" };
    await follower.step();
    assert.equal((await follower.attachCurrentNote("Tasks.md")).ok, false);
});

test("0.17: attaching an existing note to another context uses the same file and is blocked for missing notes", async () => {
    const service = new FakeService();
    const host = new FakeHost(); ["Research.md", "Tasks.md"].forEach(p => host.files.add(p));
    const { follower, mappings } = makeFollower(service, host);
    const chrome = { ...snapshot("chrome.exe", "Research page"), key: CHROME };
    service.state = { seq: 1, current: chrome, lastExternal: chrome, pauseReason: null, pauseDetail: null, acceptedTarget: chrome, availability: "ready" };
    await follower.step();
    mappings.attach(EXCEL, "Budget.md", "Budget.xlsx");
    mappings.attach(CHROME, "Research.md", "Research page");
    assert.equal((await follower.changeGroup(EXCEL, { kind: "add", path: "Research.md" })).ok, true);
    assert.deepEqual(mappings.contextsForNote("Research.md").map(c => c.key).sort(), [CHROME, EXCEL].sort());
    assert.equal((await follower.changeGroup(EXCEL, { kind: "add", path: "Gone.md" })).ok, false, "missing note is refused");
    assert.equal((await follower.changeGroup("url:unknown", { kind: "add", path: "Tasks.md" })).ok, false, "cannot invent a context");
});
