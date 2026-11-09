import assert from "node:assert/strict";
import { test } from "node:test";
import { compactStatus, describeContext, endpointLocation, safeTarget } from "../src/presentation";
import { FakeHost, FakeService, makeFollower, snapshot } from "./helpers";
import type { ContextState } from "../src/types";

const page = { ...snapshot("chrome.exe", "Documentation"), key: "url:example.com/docs?~1234567890ABCDEF" };
const state: ContextState = { seq: 4, current: page, lastExternal: page, pauseReason: null };

test("compact status distinguishes connection, manual pause, privacy, and mapping without leaking context", () => {
    assert.equal(compactStatus("connected", state, true, true), "ClingNote: Following");
    assert.equal(compactStatus("connected", state, true, false), "ClingNote: No note attached");
    assert.equal(compactStatus("connected", state, false, true), "ClingNote: Paused");
    const privateState = { ...state, pauseReason: "private-browsing" as const };
    assert.equal(compactStatus("connected", privateState, false, true), "ClingNote: Private browsing");
    assert.equal(safeTarget("connected", privateState), null, "privacy hides even malformed private payloads");
    assert.equal(safeTarget("disconnected", state), null);
    assert.equal(compactStatus("disconnected", state, true, true), "ClingNote: Disconnected");
    assert.equal(compactStatus("connecting", null, true, false), "ClingNote: Connecting…");
    assert.equal(compactStatus("connected", { ...state, current: null }, true, false), "ClingNote: No context");
});

test("details distinguish file/folder/browser/app without exposing internal key fingerprints", () => {
    assert.deepEqual(describeContext(page), { kind: "Browser", title: "Documentation", location: "example.com/docs" });
    const file = { ...snapshot("notepad.exe", "File.txt - Notepad", "C:\\Docs\\File.txt"), key: "file-id:secret-native-id" };
    assert.deepEqual(describeContext(file), { kind: "File", title: "File.txt", location: "C:\\Docs\\File.txt" });
    assert.equal(describeContext({ ...file, pathSource: "ExplorerShellWindowDiscovery" }).kind, "Folder");
    assert.deepEqual(describeContext(snapshot("ChatGPT.exe", "Research")), { kind: "App", title: "Research", location: "ChatGPT.exe" });
    assert.equal(describeContext({ ...page, title: "Updated title" }).title, "Updated title");
    assert.equal(page.key, "url:example.com/docs?~1234567890ABCDEF", "presentation does not mutate mapping identity");
});

test("endpoint discovery is predictable, respects override, and never falls back to a relative path", () => {
    assert.equal(endpointLocation("", "C:\\Users\\Test\\AppData\\Local"), "C:\\Users\\Test\\AppData\\Local\\ClingNote.Context\\endpoint.json");
    assert.equal(endpointLocation(" C:\\Beta\\endpoint.json ", "C:\\Default"), "C:\\Beta\\endpoint.json");
    assert.equal(endpointLocation(""), null);
    assert.equal(endpointLocation("relative.json"), null);
    assert.equal(endpointLocation("%LOCALAPPDATA%\\endpoint.json"), null);
});

test("manual open works while following is off; fresh privacy blocks all current-context actions", async () => {
    const service = new FakeService(), host = new FakeHost();
    let enabled = false;
    const { follower, mappings } = makeFollower(service, host, { follow: () => enabled });
    host.files.add("Research.md"); host.active = "Research.md";
    service.set(page); await follower.step();
    await follower.attachCurrentNote();
    host.active = "Other.md";
    await follower.step(); assert.equal(host.opened.length, 0);
    assert.equal((await follower.openCurrentNote()).ok, true);
    assert.equal(host.active, "Research.md");
    assert.equal(enabled, false, "manual opening leaves following setting off");
    service.state = { seq: service.state.seq + 1, current: null, lastExternal: page, pauseReason: "private-browsing" };
    assert.equal((await follower.openCurrentNote()).ok, false);
    assert.equal((await follower.attachCurrentNote()).ok, false);
    assert.equal((await follower.detachCurrentContext()).ok, false);
    assert.ok(mappings.get(page.key));
    service.set(page); host.active = "Other.md"; await follower.step();
    assert.equal(host.active, "Other.md", "privacy exit respects manual pause");
    enabled = true; await follower.refresh();
    assert.equal(host.active, "Research.md", "resume follows fresh context");
});

test("manual open handles unmapped, missing, unsupported and disconnected contexts without creating notes", async () => {
    const service = new FakeService(), host = new FakeHost();
    const { follower, mappings } = makeFollower(service, host);
    service.set(page);
    assert.match((await follower.openCurrentNote()).message, /No note is attached/);
    mappings.attach(page.key, "Gone.md", "Docs");
    assert.equal((await follower.openCurrentNote()).ok, false);
    mappings.attach(page.key, "Image.png", "Docs"); host.files.add("Image.png");
    assert.equal((await follower.openCurrentNote()).ok, false);
    service.failing = true;
    assert.match((await follower.openCurrentNote()).message, /companion isn't running/);
    assert.equal(host.opened.length, 0);
    assert.deepEqual([...host.files], ["Image.png"]);
});
