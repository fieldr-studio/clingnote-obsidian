import test from "node:test";
import assert from "node:assert/strict";
import { attachExplanation, panelContext, compactStatus } from "../src/presentation";
import { openLeftPanel } from "../src/panel-placement";
import { FakeHost, FakeService, makeFollower, snapshot } from "./helpers";
import { members } from "../src/mappings";
import type { ContextState } from "../src/types";
const a = { ...snapshot("chrome.exe", "Page A"), key: "url:example.test/a?~1234" };
const ready: ContextState = { seq: 1, current: a, lastExternal: a, acceptedTarget: a, availability: "ready", pauseReason: null };

test("panel retains accepted identity during unavailability, redacts privacy and explains every attach gate", () => {
    assert.deepEqual(panelContext("connected", ready), { heading: "Current context", title: "Chrome · Page A", location: "example.test/a", detail: "" });
    assert.equal(attachExplanation("connected", ready, "A.md"), "");
    assert.equal(attachExplanation("connected", ready, "image.png"), "Open a Markdown note first");
    for (const availability of ["privacy-unknown", "identity-unavailable"] as const) {
        const state = { ...ready, current: null, availability, pauseReason: "private-browsing" as const, pauseDetail: "verifying-context" as const };
        assert.equal(panelContext("connected", state).title, "Chrome · Page A");
        assert.equal(panelContext("connected", state).detail, "Temporarily unavailable");
        assert.equal(attachExplanation("connected", state, "A.md"), availability === "privacy-unknown" ? "Checking the browser page…" : "This window has no readable page or file address yet");
    }
    const privateState = { ...ready, availability: "private" as const };
    assert.equal(panelContext("connected", privateState).title, "");
    assert.equal(panelContext("connected", privateState).location, "");
    assert.equal(attachExplanation("connected", privateState, "A.md"), "Unavailable in private browsing");
    const none = { ...ready, current: null, acceptedTarget: null, availability: "none" as const };
    assert.equal(panelContext("connected", none).heading, "No active context");
    assert.equal(attachExplanation("connected", none, "A.md"), "Open a file, app, folder, or browser page first");
    assert.equal(panelContext("disconnected", ready).title, "");
    assert.equal(attachExplanation("disconnected", ready, "A.md"), "ClingNote companion is disconnected");
    assert.match(attachExplanation("connecting", ready, "A.md"), /Connecting/);
    assert.equal(compactStatus("connected", ready, false, true, { kind: "timed", until: Date.now() + 60000 }), "ClingNote: Paused");
});

test("renamed Main/Attach operations preserve A-B-C order, duplicates and real context following", async () => {
    const service = new FakeService(), host = new FakeHost();
    host.files = new Set(["A.md", "B.md", "C.md", "Other.md"]);
    const { follower, mappings } = makeFollower(service, host);
    service.state = ready; await follower.step();
    assert.equal((await follower.addCurrentNote("A.md")).ok, true, "first attachment becomes Main");
    await follower.addCurrentNote("B.md");
    assert.deepEqual(members(mappings.group(a.key)!), ["A.md", "B.md"]);
    await follower.attachCurrentNote("B.md");
    await follower.addCurrentNote("C.md");
    await follower.addCurrentNote("C.md");
    assert.deepEqual(members(mappings.group(a.key)!), ["B.md", "A.md", "C.md"]);
    host.active = "A.md"; await follower.step();
    assert.equal(host.active, "A.md");
    assert.equal(mappings.group(a.key)!.mainNote, "B.md");
    const b = { ...a, key: "url:example.test/b", title: "Other" };
    service.set(b); await follower.step(); await follower.attachCurrentNote("Other.md");
    service.set(a); await follower.step();
    assert.equal(host.active, "B.md");
    assert.equal(host.files.size, 4, "note files never moved/deleted");
});

test("explicit panel opening moves only ClingNote left and reuses it without extra leaves", async () => {
    const leftRoot = {}, rightRoot = {}; let created = 0, opened = 0, detached = 0, revealed = 0;
    const right = { getRoot: () => rightRoot, detach: () => { detached++; } };
    const left = { getRoot: () => leftRoot, setViewState: async () => { opened++; }, detach: () => { throw Error("must keep left"); } };
    let leaves: any[] = [right];
    const workspace: any = { leftSplit: leftRoot, getLeavesOfType: () => leaves,
        getLeftLeaf: () => { created++; return left; }, revealLeaf: async (leaf: unknown) => { assert.equal(leaf, left); revealed++; } };
    await openLeftPanel(workspace, "clingnote-context-groups"); leaves = [left];
    await openLeftPanel(workspace, "clingnote-context-groups");
    assert.deepEqual([created, opened, detached, revealed], [1, 2, 1, 2]);
    leaves = []; await openLeftPanel(workspace, "clingnote-context-groups", false);
    assert.equal(created, 1, "closed panel stays closed on startup");
    leaves = [left]; await openLeftPanel(workspace, "clingnote-context-groups", false);
    assert.equal(opened, 2, "restored left panel is untouched");
    leaves = [right]; await openLeftPanel(workspace, "clingnote-context-groups", false);
    assert.equal(revealed, 2, "relocating an existing panel never reveals or focuses it");
    assert.equal(detached, 2);
    leaves = [right]; left.setViewState = async () => { throw Error("host failure"); };
    await assert.rejects(openLeftPanel(workspace, "clingnote-context-groups"));
    assert.equal(detached, 2, "failed opening preserves old layout");
});
