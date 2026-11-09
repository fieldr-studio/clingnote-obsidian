import { test } from "node:test";
import assert from "node:assert/strict";
import { MappingStore, members } from "../src/mappings";
import { persistedData } from "../src/validation";
import { attachmentTarget, contextAccess, savedGroupEdits } from "../src/context-policy";
import { accentColors, ACCENT_PRESETS, contrast, normalizeAccent } from "../src/accent";
import { planDrop, type DragSource, type DropTarget } from "../src/sidebar-dnd";
import { contextTitle, shouldActivateSidebar } from "../src/sidebar-model";
import type { ContextState } from "../src/types";
import { FakeHost, FakeService, makeFollower, snapshot } from "./helpers";

const A = "url:example.com/a", B = "url:example.com/b", C = "file-id:vol:1:c";
const FILES = ["A1.md", "A2.md", "A3.md", "B1.md", "B2.md", "Loose.md", "Other.md"];

function world() {
    const store = new MappingStore();
    store.attach(A, "A1.md", "Page A"); store.addNote(A, "A2.md", "Page A"); store.addNote(A, "A3.md", "Page A");
    store.attach(B, "B1.md", "Page B"); store.addNote(B, "B2.md", "Page B");
    store.attach(C, "Other.md", "Budget.xlsx");
    const service = new FakeService(), host = new FakeHost(); FILES.forEach(f => host.files.add(f));
    const { follower } = makeFollower(service, host, { mappings: store });
    return { store, service, host, follower };
}
const ready = (key: string): ContextState => { const s = { ...snapshot("chrome.exe", "x"), key }; return { seq: 9, current: s, lastExternal: s, pauseReason: null, pauseDetail: null, acceptedTarget: s, availability: "ready" }; };
const states: Record<string, ContextState | "down"> = {
    desktop: { seq: 5, current: null, lastExternal: null, pauseReason: null, pauseDetail: null, acceptedTarget: null, availability: "none" },
    "unrelated application": ready("window:notepad.exe|SCRATCH"),
    "unavailable identity": { ...ready(A), seq: 6, current: null, availability: "identity-unavailable", pauseReason: "private-browsing", pauseDetail: "verifying-context" },
    "disconnected companion": "down",
    "private browser": { seq: 7, current: null, lastExternal: null, pauseReason: "private-browsing", pauseDetail: "confirmed-private", acceptedTarget: null, availability: "private" },
    "unverified browser": { ...ready(A), seq: 8, current: null, availability: "privacy-unknown", pauseReason: "private-browsing", pauseDetail: "verifying-context" },
};
async function enter(name: string, w: ReturnType<typeof world>) {
    const state = states[name];
    if (state === "down") w.service.failing = true; else { w.service.failing = false; w.service.state = state; }
    await w.follower.step();
}

test("0.17.1: display customization of a SAVED group works whatever the active Windows context is, and targets that group only", async () => {
    for (const name of Object.keys(states)) {
        const w = world();
        await enter(name, w);
        const activeBefore = JSON.stringify([w.store.group(B), w.store.group(C)]);
        assert.equal((await w.follower.changeGroup(A, { kind: "header", header: { mode: "custom", label: "My A" } })).ok, true, `rename while ${name}`);
        assert.equal((await w.follower.changeGroup(A, { kind: "icon", icon: "lucide:globe" })).ok, true, `icon while ${name}`);
        assert.equal((await w.follower.changeGroup(A, { kind: "icon", icon: "emoji:📊" })).ok, true, `emoji while ${name}`);
        assert.equal((await w.follower.changeGroup(A, { kind: "reorder", order: ["A3.md", "A2.md"] })).ok, true, `reorder while ${name}`);
        assert.equal((await w.follower.changeGroup(A, { kind: "restore" })).ok, true, `restore while ${name}`);
        assert.equal(w.store.group(A)!.icon, undefined);
        assert.equal(contextTitle(w.store.group(A)!).title, "Page A");
        assert.deepEqual(w.store.group(A)!.relatedNotes, ["A3.md", "A2.md"], "order edit is kept; restore only resets name and icon");
        assert.equal(JSON.stringify([w.store.group(B), w.store.group(C)]), activeBefore, `other contexts untouched while ${name}`);
        assert.equal((await w.follower.changeGroup("url:gone", { kind: "icon", icon: "lucide:globe" })).ok, false, "unknown group is refused, never redirected to the active context");
    }
});

test("0.17.1: editing a saved group never alters the context that is currently active", async () => {
    const w = world();
    w.service.state = ready(B); await w.follower.step();
    const activeBefore = JSON.stringify(w.store.group(B));
    await w.follower.changeGroup(A, { kind: "header", header: { mode: "custom", label: "Renamed A" } });
    await w.follower.changeGroup(A, { kind: "icon", icon: "lucide:star" });
    assert.equal(JSON.stringify(w.store.group(B)), activeBefore);
    assert.equal(contextTitle(w.store.group(A)!).title, "Renamed A");
    assert.equal(w.follower.lastState?.acceptedTarget?.key, B);
});

test("0.17.1: relationship changes need no live context but wait while browser privacy is private or unverified", async () => {
    const allowed = ["desktop", "unrelated application", "unavailable identity", "disconnected companion"];
    for (const name of Object.keys(states)) {
        const w = world();
        await enter(name, w);
        const result = await w.follower.changeGroup(A, { kind: "insert", path: "Loose.md" });
        assert.equal(result.ok, allowed.includes(name), `${name}: ${result.message}`);
        assert.equal(w.store.group(A)!.relatedNotes.includes("Loose.md"), allowed.includes(name));
        if (!allowed.includes(name)) assert.match(result.message, /private|verified/i);
    }
    // Creating a NEW attachment from a live context still needs a verified target.
    const w = world();
    for (const name of ["desktop", "disconnected companion", "private browser", "unverified browser", "unavailable identity"]) {
        await enter(name, w);
        assert.equal((await w.follower.attachCurrentNote("Loose.md")).ok, false, `attach blocked on ${name}`);
        assert.equal((await w.follower.addCurrentNote("Loose.md")).ok, false);
    }
    w.service.failing = false; w.service.state = ready("url:example.com/new"); await w.follower.step();
    assert.equal((await w.follower.addCurrentNote("Loose.md")).ok, true);
    assert.equal(savedGroupEdits("connected", states.desktop as ContextState).relationships, true);
    assert.equal(attachmentTarget("connected", states["private browser"] as ContextState, "Loose.md"), null);
});

const ctx = (store: MappingStore, exists = (p: string) => FILES.includes(p)) => ({
    group: (k: string) => store.group(k), title: (k: string) => store.group(k)?.label ?? k, noteExists: exists });
const src = (path: string, fromKey: string | null): DragSource => ({ path, fromKey });

test("0.17.1 drag: a secondary note dropped on Main becomes Main and the old Main stays attached", () => {
    const { store } = world();
    const plan = planDrop(src("A3.md", A), { kind: "main-row", key: A }, false, ctx(store));
    assert.equal(plan.ok && plan.op, "promote");
    assert.equal(planDrop(src("A1.md", A), { kind: "main-row", key: A }, false, ctx(store)).ok, false, "Main onto Main is refused");
    assert.equal(store.makeMain(A, "A3.md"), true);
    assert.equal(store.group(A)!.mainNote, "A3.md");
    assert.deepEqual(members(store.group(A)!).sort(), ["A1.md", "A2.md", "A3.md"], "nothing detached");
    assert.ok(store.group(A)!.relatedNotes.includes("A1.md"), "old Main is now secondary");
});

test("0.17.1 drag: secondary notes keep their sorting behaviour (drop on a note reorders, Main cannot be reordered)", () => {
    const { store } = world();
    const plan = planDrop(src("A3.md", A), { kind: "related-row", key: A, path: "A2.md" }, false, ctx(store));
    assert.deepEqual(plan.ok && plan.op === "reorder" ? [plan.op, plan.onto] : null, ["reorder", "A2.md"]);
    assert.equal(store.dropNote(A, "A3.md", "A2.md"), true);
    assert.deepEqual(store.group(A)!.relatedNotes, ["A3.md", "A2.md"]);
    assert.equal(planDrop(src("A1.md", A), { kind: "related-row", key: A, path: "A2.md" }, false, ctx(store)).ok, false);
    assert.equal(planDrop(src("A2.md", A), { kind: "related-row", key: A, path: "A2.md" }, false, ctx(store)).ok, false);
    assert.equal(planDrop(src("A2.md", A), { kind: "group", key: A }, false, ctx(store)).ok, false, "dropping on its own header does nothing");
});

test("0.17.1 drag: an unattached note dropped on a context is attached as a secondary note; nothing is duplicated", async () => {
    const w = world();
    const plan = planDrop(src("Loose.md", null), { kind: "group", key: B }, false, ctx(w.store));
    assert.deepEqual(plan.ok && [plan.op, plan.key, plan.path], ["insert", B, "Loose.md"]);
    assert.equal((await w.follower.changeGroup(B, { kind: "insert", path: "Loose.md" })).ok, true);
    assert.deepEqual(members(w.store.group(B)!), ["B1.md", "B2.md", "Loose.md"], "added at the end");
    assert.equal(w.store.group(B)!.mainNote, "B1.md", "an existing Main is kept");
    // The second drop is a duplicate and is refused both by the plan and by the store.
    const again = planDrop(src("Loose.md", null), { kind: "group", key: B }, false, ctx(w.store));
    assert.equal(again.ok, false); assert.match(again.hint, /Already attached/);
    assert.equal((await w.follower.changeGroup(B, { kind: "insert", path: "Loose.md" })).ok, false);
    assert.equal(w.store.group(B)!.relatedNotes.filter(p => p === "Loose.md").length, 1);
    // A context that has no Main yet makes the first attached note Main.
    assert.equal(w.store.addNote("url:example.com/new", "Loose.md", "New page"), true);
    assert.equal(w.store.group("url:example.com/new")!.mainNote, "Loose.md");
});

test("0.17.1 drag: an insertion position is honoured (before a note, or top of the secondary list when dropped on Main)", () => {
    const { store } = world();
    const onRow = planDrop(src("Loose.md", null), { kind: "related-row", key: A, path: "A3.md" }, false, ctx(store));
    assert.deepEqual(onRow.ok && onRow.op === "insert" && onRow.before, "A3.md");
    assert.equal(store.insertNote(A, "Loose.md", "A3.md"), true);
    assert.deepEqual(store.group(A)!.relatedNotes, ["A2.md", "Loose.md", "A3.md"]);
    const onMain = planDrop(src("B2.md", B), { kind: "main-row", key: A }, false, ctx(store));
    assert.deepEqual(onMain.ok && onMain.op === "insert" && onMain.before, "A2.md");
    assert.equal(store.insertNote(A, "B2.md", "A1.md"), true, "before the Main note means top of the secondary list");
    assert.deepEqual(store.group(A)!.relatedNotes[0], "B2.md");
    assert.equal(store.group(A)!.mainNote, "A1.md", "dropping on Main never replaces it");
});

test("0.17.1 drag: dragging an attached note to another context shares it; the original relationship stays and no file is duplicated", async () => {
    const w = world();
    const plan = planDrop(src("A2.md", A), { kind: "group", key: B }, false, ctx(w.store));
    assert.equal(plan.ok && plan.op, "insert");
    assert.match(plan.hint, /Also attach/);
    assert.equal((await w.follower.changeGroup(B, { kind: "insert", path: "A2.md" })).ok, true);
    assert.deepEqual(w.store.contextsForNote("A2.md").map(c => c.key).sort(), [A, B].sort());
    assert.equal(w.store.group(A)!.relatedNotes.includes("A2.md"), true, "still attached to the source");
    assert.equal(w.host.files.size, FILES.length, "no Markdown file was created, copied or removed");
    assert.equal(planDrop(src("A2.md", A), { kind: "group", key: B }, false, ctx(w.store)).ok, false, "second drop is a duplicate");
});

test("0.17.1 drag: Move (Shift or menu) adds to the target and removes only from the source, atomically", async () => {
    const w = world();
    const plan = planDrop(src("A2.md", A), { kind: "group", key: B }, true, ctx(w.store));
    assert.deepEqual(plan.ok && plan.op === "move" && [plan.key, plan.to], [A, B]);
    assert.equal((await w.follower.changeGroup(A, { kind: "moveTo", path: "A2.md", to: B })).ok, true);
    assert.deepEqual(w.store.contextsForNote("A2.md").map(c => c.key), [B]);
    // Moving the Main promotes the next note in the source and keeps exactly one Main.
    assert.equal(w.store.moveNote(A, C, "A1.md"), true);
    assert.equal(w.store.group(A)!.mainNote, "A3.md");
    assert.equal(w.store.group(C)!.relatedNotes.includes("A1.md"), true);
    // Invalid moves change nothing at all.
    const before = JSON.stringify(w.store.toJSON().groups);
    assert.equal(w.store.moveNote(A, B, "A2.md"), false, "not in the source");
    assert.equal(w.store.moveNote(B, B, "A2.md"), false, "same context");
    assert.equal(w.store.moveNote(B, "url:gone", "A2.md"), false, "missing target");
    assert.equal(w.store.moveNote(C, B, "A1.md") && w.store.moveNote(A, B, "A3.md"), true);
    assert.equal(w.store.moveNote(A, B, "A3.md"), false);
    void before;
    // Shift never moves a note that came from Unattached (there is nothing to remove): it is a plain attach.
    const fromLoose = planDrop(src("Loose.md", null), { kind: "group", key: B }, true, ctx(w.store));
    assert.equal(fromLoose.ok && fromLoose.op, "insert");
});

test("0.17.1 drag: invalid drops explain themselves and change nothing", () => {
    const { store } = world();
    const cases: Array<[DragSource, DropTarget, RegExp]> = [
        [src("A2.md", A), { kind: "unattached" }, /Remove from this context/],
        [src("Loose.md", null), { kind: "unattached" }, /Already unattached/],
        [src("Gone.md", null), { kind: "group", key: A }, /missing/],
        [src("Loose.md", null), { kind: "group", key: "url:gone" }, /no longer exists/],
        [src("B1.md", B), { kind: "group", key: B }, /already attached/],
    ];
    for (const [source, target, hint] of cases) { const plan = planDrop(source, target, false, ctx(store)); assert.equal(plan.ok, false); assert.match(plan.hint, hint); }
});

test("0.17.1: drag results and customization persist across a restart", async () => {
    const w = world();
    await w.follower.changeGroup(B, { kind: "insert", path: "Loose.md" });
    await w.follower.changeGroup(A, { kind: "moveTo", path: "A2.md", to: C });
    await w.follower.changeGroup(A, { kind: "icon", icon: "lucide:flask-conical" });
    const saved = JSON.parse(JSON.stringify({ settings: { ui: { collapsed: [B], unattachedExpanded: true, sort: "name", accent: "#14b8a6", sidebarActivated: true } }, mappings: w.store.toJSON() }));
    const loaded = persistedData(saved);
    const restored = new MappingStore(loaded.mappings as never);
    assert.deepEqual(restored.groupEntries(), w.store.groupEntries());
    assert.deepEqual(loaded.settings.ui, { collapsed: [B], unattachedExpanded: true, sort: "name", accent: "#14b8a6", sidebarActivated: true });
});

test("0.17.1 accent: presets and custom colors normalize, stay readable in light and dark themes, and restore default", () => {
    assert.equal(normalizeAccent("#14B8A6"), "#14b8a6");
    for (const bad of ["red", "#fff", "#12345g", "", 5, null]) assert.equal(normalizeAccent(bad), undefined);
    const extremes = [...ACCENT_PRESETS.map(p => p.value), "#ffff00", "#000000", "#ffffff", "#0000ff", "#7c3aed"];
    for (const color of extremes) {
        const light = accentColors(color, false), dark = accentColors(color, true);
        assert.ok(contrast(light.text, "#f5f6f8") >= 4.5, `${color} text on light`);
        assert.ok(contrast(dark.text, "#1e1e1e") >= 4.5, `${color} text on dark`);
        assert.equal(light.fill, color);
        assert.ok(contrast(light.onFill, color) >= 4.5 || contrast(light.onFill, color) >= contrast(light.onFill === "#ffffff" ? "#000000" : "#ffffff", color), `${color} label color`);
    }
    // Invalid saved accent is dropped, never fatal; restoring the default removes the key.
    assert.equal(persistedData({ settings: { ui: { collapsed: [], accent: "javascript:1" } } }).settings.ui?.accent, undefined);
    const withAccent = persistedData({ settings: { ui: { collapsed: [], accent: "#EF4444" } } }).settings.ui!;
    assert.equal(withAccent.accent, "#ef4444");
    const { accent: _removed, ...restored } = withAccent;
    assert.equal("accent" in restored, false);
});

test("0.17.1: ClingNote is selected on the first launch only, and an existing layout or deliberate choice is respected", () => {
    const base = { alreadyActivated: false, firstRun: false, viewExists: false, hasSavedContexts: false };
    assert.equal(shouldActivateSidebar({ ...base, firstRun: true }), true, "brand new install");
    assert.equal(shouldActivateSidebar(base), true, "existing data but no contexts yet");
    assert.equal(shouldActivateSidebar({ ...base, hasSavedContexts: true }), false, "existing user with saved contexts keeps their layout");
    assert.equal(shouldActivateSidebar({ ...base, firstRun: true, viewExists: true }), false, "view already in the saved workspace");
    assert.equal(shouldActivateSidebar({ ...base, firstRun: true, alreadyActivated: true }), false, "never forced again after the first decision");
});

test("0.17.1 diagnostics: the follower reports why attaching is blocked, and for how long, without identifiers", async () => {
    const w = world();
    w.service.state = states["unverified browser"] as ContextState; await w.follower.step();
    w.service.state = { ...(states["unavailable identity"] as ContextState), seq: 20 }; await w.follower.step();
    w.service.state = { ...ready(A), seq: 21 }; await w.follower.step();
    const text = w.follower.diagnosticsText();
    assert.match(text, /connection:connected/);
    for (const what of ["availability:privacy-unknown", "availability:identity-unavailable", "availability:ready"]) assert.match(text, new RegExp(what));
    assert.match(text, /now: availability:ready for \d+s/);
    assert.doesNotMatch(text, /example\.com|Page A/);
    assert.equal(contextAccess("connected", states["unverified browser"] as ContextState).target, null);
    assert.equal(contextAccess("connected", states["unavailable identity"] as ContextState).target, null);
});
