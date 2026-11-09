import test from "node:test";
import assert from "node:assert/strict";
import { compactStatus, safeTarget } from "../src/presentation";
import { contextState } from "../src/validation";
import { FakeService, FakeHost, makeFollower, snapshot } from "./helpers";

test("verification and private pauses have distinct wording, block following, and recover on a safe file", async () => {
    const service = new FakeService(), host = new FakeHost();
    const { follower, mappings } = makeFollower(service, host);
    const file = snapshot("notepad.exe", "Mapped.txt", "C:\\Tests\\Mapped.txt");
    host.files.add("Mapped.md"); mappings.attach(file.key, "Mapped.md", "Mapped");
    for (const detail of ["verifying-context", "confirmed-private"] as const) {
        service.state = { seq: service.state.seq + 1, current: null, lastExternal: file, pauseReason: "private-browsing", pauseDetail: detail };
        assert.ok(contextState(service.state));
        assert.equal(safeTarget("connected", service.state), null);
        assert.equal(compactStatus("connected", service.state, true, true), detail === "verifying-context" ? "ClingNote: Context unavailable" : "ClingNote: Private browsing");
        await follower.step(); assert.equal(host.opened.length, 0);
    }
    service.set(file); await follower.step();
    assert.deepEqual(host.opened, ["Mapped.md"]);
    assert.equal(compactStatus("connected", service.state, true, true), "ClingNote: Following");
    assert.equal(contextState({ ...service.state, pauseDetail: "verifying-context" }), false);
});

test("first attachment -> change note -> unavailable -> safe second attachment", async () => {
    const service = new FakeService(), host = new FakeHost();
    const { follower, mappings } = makeFollower(service, host);
    const a = { ...snapshot("chrome.exe", "Page A"), key: "url:example.test/a" };
    const b = { ...a, title: "Page B", key: "url:example.test/b" };
    host.files.add("Browser A.md").add("b browser.md");
    host.active = "Browser A.md";
    service.set(a); await follower.step();
    assert.equal((await follower.attachCurrentNote()).ok, true);
    host.active = "b browser.md";
    service.state = { seq: 2, current: null, lastExternal: a, pauseReason: "private-browsing", pauseDetail: "verifying-context" };
    await follower.step();
    assert.equal((await follower.attachCurrentNote()).ok, false);
    assert.equal(compactStatus(follower.status, follower.lastState, true, false), "ClingNote: Context unavailable");
    // Obsidian preserves the known target and its blocked eligibility, without declaring it safe.
    service.state = { seq: 3, current: null, lastExternal: a, acceptedTarget: a, availability: "privacy-unknown", pauseReason: "private-browsing", pauseDetail: "verifying-context" };
    await follower.step();
    assert.equal(compactStatus(follower.status, follower.lastState, true, false), "ClingNote: Context unavailable");
    assert.equal(safeTarget(follower.status, follower.lastState), null);
    assert.equal((await follower.attachCurrentNote()).ok, false, "must not silently reuse A");
    assert.equal(mappings.get(a.key)?.notePath, "Browser A.md");
    service.set(b); await follower.step();
    assert.equal(safeTarget(follower.status, follower.lastState)?.key, b.key, "same target predicate re-enables menu");
    assert.equal((await follower.attachCurrentNote()).ok, true);
    assert.equal(mappings.get(b.key)?.notePath, "b browser.md");
    assert.deepEqual(host.opened, [], "switching Obsidian notes does not reopen the first mapping");
    service.failing = true;
    assert.equal(await follower.confirmNormalContext(), false);
    assert.equal(follower.status, "disconnected");
    assert.equal(follower.lastState, null, "failed command cannot leave stale verification behind");
    service.failing = false;
    assert.equal(await follower.confirmNormalContext(), true);
    assert.equal(follower.status, "connected", "fresh command also recovers connection status");
});
