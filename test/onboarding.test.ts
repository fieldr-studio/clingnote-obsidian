import test from "node:test";
import assert from "node:assert/strict";
import { connectionGuidance, connectionNotice, downloadUrl, COMPANION_DOWNLOAD_URL } from "../src/onboarding";
import { ConnectionError } from "../src/client";
import { discoverEndpoint } from "../src/discovery";

const all = ["missing", "installed", "interrupted", "incompatible", null] as const;
test("user-facing text never mentions development terminology or stale versions", () => {
 for (const issue of all) {
  const texts = [connectionGuidance("disconnected", issue), connectionNotice("disconnected", issue, true)!.text, connectionNotice("disconnected", issue, false)!.text];
  for (const t of texts) { assert.doesNotMatch(t, /DevLab|beta|0\.0\.\d+|trusted/i); assert.ok(t.length > 10); }
 }
});
test("each state has distinct, evidence-based guidance", () => {
 assert.match(connectionGuidance("connected", null), /safety checks/);
 assert.match(connectionGuidance("disconnected", "missing"), /runs on your PC.*not appear to be installed/s);
 assert.match(connectionGuidance("disconnected", "installed"), /installed but not running/);
 assert.match(connectionGuidance("disconnected", "interrupted"), /interrupted/);
 assert.match(connectionGuidance("disconnected", "incompatible"), /protocol 1/);
 assert.doesNotMatch(connectionGuidance("disconnected", null), /installed but not running|not appear to be installed/);
 assert.match(connectionGuidance("connecting", null), /Connecting/);
});
test("sidebar notice: none when connected, recovery action only when supported", () => {
 assert.equal(connectionNotice("connected", null, true), null);
 assert.equal(connectionNotice("connecting", "missing", true), null);
 assert.equal(connectionNotice("disconnected", "missing", true)!.action, "download");
 assert.equal(connectionNotice("disconnected", "missing", false)!.action, null);
 assert.equal(connectionNotice("disconnected", "installed", false)!.action, "retry");
 assert.equal(connectionNotice("disconnected", "incompatible", false)!.action, "retry");
 assert.deepEqual(connectionNotice("disconnected", null, true), { text: "Not connected to the companion.", action: "retry" });
});
test("the official download URL is HTTPS and configuration rejects unsafe schemes", () => {
 assert.equal(downloadUrl(COMPANION_DOWNLOAD_URL), "https://clingnote.com/obsidian");
 for (const s of ["javascript:alert(1)", "file:///x", "http://example.test", "https://user:pass@example.test"]) assert.equal(downloadUrl(s),null);
 assert.equal(downloadUrl("https://example.test/download"), "https://example.test/download");
});
test("a stale endpoint file is not proof of anything: discovery returns it, connection failure stays neutral", async () => {
 const ep = await discoverEndpoint("", "C:\\Users\\u\\AppData\\Local", async () => JSON.stringify({ port: 1, token: "t" }));
 assert.equal(ep!.port, 1); // reading succeeds; the client's failed request is what decides, and it has no reason
 assert.equal(new ConnectionError("Could not reach the ClingNote context service: x").reason, undefined);
});
import { FakeHost, FakeService, makeFollower, snapshot } from "./helpers";
test("follower: first failure is neutral, loss after a connection is 'interrupted', recovery clears it", async () => {
 const service = new FakeService(); const { follower } = makeFollower(service, new FakeHost());
 service.failing = true; await follower.step();
 assert.equal(follower.connectionIssue, null, "never connected: a dead or stale endpoint proves nothing");
 service.failing = false; service.set(snapshot("cmd.exe", "A", "")); await follower.step();
 assert.equal(follower.status, "connected"); assert.equal(follower.connectionIssue, null);
 service.failing = true; await follower.step();
 assert.equal(follower.status, "disconnected"); assert.equal(follower.connectionIssue, "interrupted");
 await follower.step(); assert.equal(follower.connectionIssue, "interrupted", "stays interrupted while unreachable");
 service.failing = false; await follower.step();
 assert.equal(follower.status, "connected"); assert.equal(follower.connectionIssue, null);
});
test("follower: a changed reason while already disconnected still notifies the UI", async () => {
 const service = new FakeService(); const calls: string[] = [];
 const { follower } = makeFollower(service, new FakeHost());
 (follower as unknown as { hooks: { onStatus?: (s: string) => void } }).hooks.onStatus = s => calls.push(s);
 service.failing = true; await follower.step(); const n = calls.length;
 await follower.step(); assert.equal(calls.length, n, "no reason change, no extra refresh");
 (follower as unknown as { connectionIssue: string | null }).connectionIssue = "installed"; await follower.step();
 assert.equal(calls.length, n + 1);
});
