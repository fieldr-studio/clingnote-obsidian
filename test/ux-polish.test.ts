import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { MappingStore } from "../src/mappings";
import { reconcilePause, pauseLabel } from "../src/pause";
import { compactStatus } from "../src/presentation";
import { fileStamp, navigationAllowed, navigationFor, safePage, safeLocalPath } from "../src/navigation";
import { persistedData } from "../src/validation";
import { DEFAULT_SETTINGS, type ClingNoteSettings, type ContextState } from "../src/types";
import { FakeHost, FakeService, makeFollower, snapshot } from "./helpers";

test("timed pause survives reload, expires deterministically and does not change privacy", () => {
    let settings: ClingNoteSettings = { ...DEFAULT_SETTINGS, followEnabled: false, pause: { kind: "timed", until: 900000 } };
    settings = persistedData(JSON.parse(JSON.stringify({ settings }))).settings;
    assert.equal(reconcilePause(settings, 60000, "session"), false);
    assert.equal(pauseLabel(settings.pause, 60000), "ClingNote: Paused · 14m");
    assert.equal(reconcilePause(settings, 900000, "session"), true);
    assert.equal(settings.followEnabled, true);
    assert.equal(reconcilePause(settings, 900001, "session"), false);
    const state: ContextState = { seq: 1, current: null, lastExternal: null, pauseReason: "private-browsing" };
    assert.match(compactStatus("connected", state, settings.followEnabled, false), /private browsing/i);
});
test("restart pause survives plugin reload but clears on a new renderer session; legacy pause stays indefinite", () => {
    const settings: ClingNoteSettings = { ...DEFAULT_SETTINGS, followEnabled: false, pause: { kind: "restart", session: "one" } };
    assert.equal(reconcilePause(settings, 1, "one"), false);
    const reload = persistedData({ settings }).settings;
    assert.equal(reconcilePause(reload, 2, "one"), false);
    assert.equal(reconcilePause(reload, 3, "two"), true);
    const legacy = persistedData({ settings: { followEnabled: false } }).settings;
    assert.equal(reconcilePause(legacy, Number.MAX_SAFE_INTEGER, "two"), false);
    assert.equal(pauseLabel(legacy.pause, 3), "ClingNote: Paused");
});
test("recent history bounded, persisted, readable and undo affects only mappings", () => {
    const store = new MappingStore();
    store.attach("one", "A.md", "Document A");
    assert.equal(store.undo(store.recent()[0].id, () => true), true);
    assert.equal(store.get("one"), undefined);
    store.attach("one", "A.md", "Document A"); store.detach("one");
    const reload = new MappingStore(persistedData({ mappings: store.toJSON() }).mappings);
    assert.equal(reload.undo(reload.recent()[0].id, () => true), true);
    assert.equal(reload.get("one")?.notePath, "A.md");
    for (let i = 0; i < 30; i++) store.attach(`key${i}`, "A.md", "Document A");
    assert.equal(store.recent().length, 20);
    assert.equal(new MappingStore(store.toJSON()).recent().length, 20);
});
test("undo refuses intervening changes, missing notes, renamed detached notes, and repeated undo", () => {
    const store = new MappingStore();
    store.attach("key", "A.md", "A"); const old = store.recent()[0].id;
    store.attach("key", "B.md", "B");
    assert.equal(store.undo(old, () => true), false);
    assert.equal(store.undo(store.recent()[0].id, () => false), false);
    assert.equal(store.undo(store.recent()[0].id, () => true), true);
    assert.equal(store.undo(store.recent()[0].id, () => true), false);
    store.detach("key"); const detach = store.recent()[0].id;
    assert.ok(store.renameNote("A.md", "Moved.md") > 0);
    assert.equal(store.undo(detach, () => true), false);
});
test("private contexts cannot add activity; metadata refresh does not create an action or reopen a note", async () => {
    const service = new FakeService(), host = new FakeHost();
    const { follower, mappings } = makeFollower(service, host);
    host.files.add("A.md"); host.active = "A.md";
    const page = { ...snapshot("chrome.exe", "A"), key: "url:example.com/a" };
    service.set(page); await follower.attachCurrentNote();
    const count = mappings.recent().length;
    service.state = { seq: 3, current: null, lastExternal: page, pauseReason: "private-browsing" };
    assert.equal((await follower.attachCurrentNote()).ok, false);
    assert.equal((await follower.detachCurrentContext()).ok, false);
    assert.equal(mappings.recent().length, count);
    assert.equal(await follower.confirmNormalContext(), false);
    service.set({ ...page, title: "Refreshed" }); await follower.step();
    assert.equal(host.opened.length, 0);
    assert.equal(mappings.recent().length, count);
    assert.equal(mappings.get(page.key)?.navigation?.kind, "page");
});
test("optional unmapped hint is quiet and subordinate to manual/privacy pause", () => {
    const page = snapshot("app", "A");
    const state: ContextState = { seq: 1, current: page, lastExternal: page, pauseReason: null };
    assert.equal(compactStatus("connected", state, true, false, undefined, true), "ClingNote: No note attached");
    assert.equal(compactStatus("connected", state, true, false, undefined, false), "ClingNote: Ready");
    assert.equal(compactStatus("connected", state, false, false, undefined, true), "ClingNote: Paused");
});
test("reverse page navigation rejects executable schemes, credentials, controls, and irrecoverable query hashes", () => {
    for (const bad of ["javascript:alert(1)", "file:///C:/test", "http://example.com", "https://user:pass@example.com", "https://example.com/%0a", "https://example.com/\\evil"]) assert.equal(safePage(bad), false);
    const page = { ...snapshot("chrome.exe", "A"), key: "url:example.com/a" };
    assert.deepEqual(navigationFor(page), { kind: "page", url: "https://example.com/a" });
    assert.equal(navigationFor({ ...page, key: "url:example.com/a?~ABCDEF" }), undefined);
    assert.equal(navigationFor(snapshot("word.exe", "A")), undefined);
    for (const bad of ["C:\\a.txt:stream", "\\\\server\\share", "C:\\a\\..\\b.txt", "relative.txt"]) assert.equal(safeLocalPath(bad), false);
});
test("reverse file navigation rejects missing/replaced targets, scripts and shortcuts; allows reveal", () => {
    const root = mkdtempSync(resolve(process.env.TEMP ?? process.env.TMPDIR ?? "/tmp", "clingnote-ux-navigation-"));
    try {
        const path = join(root, "a.txt"); writeFileSync(path, "test fixture");
        const context = { ...snapshot("notepad.exe", "a.txt", path), key: "file-id:test" };
        const target = navigationFor(context)!;
        assert.ok(target); assert.equal(navigationAllowed(target, false), true);
        renameSync(path, join(root, "moved.txt"));
        assert.equal(navigationAllowed(target, false), false);
        writeFileSync(path, "replacement"); assert.equal(navigationAllowed(target, false), false);
        const script = join(root, "test.cmd"); writeFileSync(script, "never execute");
        const unsafe = { kind: "file" as const, path: script, stamp: fileStamp(script, false)! };
        assert.equal(navigationAllowed(unsafe, false), false);
        assert.equal(navigationAllowed(unsafe, true), true);
        const folder = navigationFor({ ...context, path: root, pathSource: "ExplorerShellWindowDiscovery" })!;
        assert.equal(navigationAllowed(folder, false), true);
    } finally { rmSync(root, { recursive: true, force: true }); }
});
test("malformed new settings/history/navigation fail without silently losing saved data", () => {
    assert.throws(() => persistedData({ settings: { pause: { kind: "timed", until: "tomorrow" } } }));
    assert.throws(() => persistedData({ mappings: { version: 1, mappings: {}, activity: [{ id: 1 }] } }));
    assert.throws(() => persistedData({ mappings: { version: 1, mappings: { key: { notePath: "A.md", label: "A", navigation: { kind: "page", url: "file:///test" } } } } }));
});
