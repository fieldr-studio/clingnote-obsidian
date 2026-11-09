import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { MappingStore } from "../src/mappings";
import { activityLabel, freshActivity, quickActivity, UNDO_WINDOW_MS } from "../src/activity";
import { fileStamp, openStoredAttachment, type NavigationShell } from "../src/navigation";

test("saved reverse navigation opens closed files without any live context or client", async () => {
    const root = mkdtempSync(resolve(process.env.TEMP ?? process.env.TMPDIR ?? "/tmp", "clingnote-edgecase-open-"));
    const opened: string[] = [];
    const shell: NavigationShell = { openPath: async path => { opened.push(path); return ""; }, openExternal: async url => { opened.push(url); }, showItemInFolder: path => { opened.push(path); } };
    try {
        const path = join(root, "closed.txt"); writeFileSync(path, "test fixture");
        const target = { kind: "file" as const, path, stamp: fileStamp(path, false)! };
        // The implementation has no current-context argument, network client, or foreground query.
        assert.equal(await openStoredAttachment(target, false, shell), null);
        assert.equal(await openStoredAttachment(target, true, shell), null);
        assert.deepEqual(opened, [path, path]);
        assert.equal(await openStoredAttachment({ kind: "page", url: "https://example.com/a" }, false, shell), null);
        assert.equal(opened.at(-1), "https://example.com/a");
        rmSync(path);
        assert.match((await openStoredAttachment(target, false, shell))!, /Attached file not found/);
        assert.equal(opened.length, 3, "missing file never reaches OS shell");
    } finally { rmSync(root, { recursive: true, force: true }); }
});
test("reverse navigation still refuses replacements and unsafe schemes before shell access", async () => {
    const shell: NavigationShell = { openPath: async () => { throw new Error("must not open"); }, openExternal: async () => { throw new Error("must not open"); }, showItemInFolder: () => { throw new Error("must not reveal"); } };
    assert.match((await openStoredAttachment({ kind: "file", path: "C:\\test.txt", stamp: "1:2:3" }, false, shell, () => "1:4:5"))!, /replaced/);
    assert.match((await openStoredAttachment({ kind: "page", url: "javascript:alert(1)" }, false, shell))!, /unavailable/);
});
test("recent menu selects latest five with action/note/context/time, full history stays capped at twenty", () => {
    const store = new MappingStore();
    for (let i = 0; i < 25; i++) store.attach(`native-secret-${i}`, `Note ${i}.md`, `File ${i}.txt`);
    const recent = store.recent(), quick = quickActivity(recent);
    assert.equal(recent.length, 20); assert.equal(quick.length, 5);
    assert.deepEqual(quick.map(item => item.after?.notePath), [24,23,22,21,20].map(i => `Note ${i}.md`));
    assert.match(activityLabel(quick[0], quick[0].at + 120000), /Attached.*Note 24.md.*File 24.txt.*2m ago/);
    assert.doesNotMatch(activityLabel(quick[0]), /native-secret/);
    store.detach("native-secret-24"); assert.match(activityLabel(store.recent()[0]), /Detached.*Note 24.md/);
});
test("specific undo expires at fifteen minutes while action remains visible, including after reload", () => {
    const store = new MappingStore(); store.attach("key", "A.md", "A.txt");
    const item = store.recent()[0];
    assert.equal(freshActivity(item, item.at + UNDO_WINDOW_MS - 1), true);
    assert.equal(freshActivity(item, item.at + UNDO_WINDOW_MS), false);
    assert.equal(freshActivity(item, item.at - 1), false, "future timestamp cannot grant undo");
    const reload = new MappingStore(JSON.parse(JSON.stringify(store.toJSON())));
    assert.equal(reload.undo(item.id, () => true, item.at + UNDO_WINDOW_MS), false);
    assert.equal(reload.recent().length, 1); assert.equal(reload.get("key")?.notePath, "A.md");
    assert.equal(store.undo(item.id, () => true, item.at + 1), true);
    assert.equal(store.get("key"), undefined);
});
test("specific undo detach restores only that mapping and refuses subsequent mutation", () => {
    const store = new MappingStore(); store.attach("A", "A.md", "A.txt"); store.attach("B", "B.md", "B.txt");
    store.detach("A"); const action = store.recent()[0];
    assert.equal(store.undo(action.id, () => true, action.at + 1), true);
    assert.equal(store.get("A")?.notePath, "A.md"); assert.equal(store.get("B")?.notePath, "B.md");
    store.detach("A"); const old = store.recent()[0]; store.attach("A", "New.md", "A.txt");
    assert.equal(store.undo(old.id, () => true, old.at + 2), false);
});
