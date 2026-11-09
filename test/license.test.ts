import test from "node:test";
import assert from "node:assert/strict";
import { LicenseClient, LicenseController, nextLicenseNotice, parseReply, replyMessage, sidebarLicenseNote, statusHeadline, NOTICE_TEXT, type LicenseStatus } from "../src/license";
import { persistedData } from "../src/validation";
import { FakeHost, FakeService, makeFollower, snapshot } from "./helpers";
import { MappingStore } from "../src/mappings";

const base: LicenseStatus = { mode: "free", entitled: false, trialStartedUtc: null, trialEndsUtc: null, trialDaysRemaining: null, leaseExpiresUtc: null, notice: null };
const trial = (days: number): LicenseStatus => ({ ...base, mode: "trial", entitled: true, trialDaysRemaining: days });
const pro: LicenseStatus = { ...base, mode: "pro", entitled: true, leaseExpiresUtc: "2026-12-01T00:00:00Z" };
const reply = (status: LicenseStatus, code = "ok", ok = true) => JSON.stringify({ ok, code, status });

test("license replies: malformed or contradictory entitlement is never accepted", () => {
 assert.equal(parseReply("nope"), null);
 assert.equal(parseReply(JSON.stringify({ ok: true })), null);
 assert.equal(parseReply(reply({ ...base, mode: "expired", entitled: true }))!.status, null, "expired cannot claim entitlement");
 assert.equal(parseReply(reply({ ...base, mode: "free", entitled: true }))!.status, null, "free cannot claim entitlement");
 assert.equal(parseReply(reply({ ...base, mode: "admin" as never }))!.status, null, "unknown mode");
 assert.equal(parseReply(reply(pro))!.status!.mode, "pro");
});

test("license client: local request only, key only in the activate body", async () => {
 const seen: Array<{ method: string; url: string; headers: Record<string, string>; body?: string }> = [];
 const client = new LicenseClient(async () => ({ port: 4321, token: "tok" } as never), async (method, url, headers, body) => {
  seen.push({ method, url, headers, body }); return { status: 200, text: reply(pro) };
 });
 await client.status(); await client.startTrial(); await client.refresh(); await client.deactivate(); await client.activate("SECRET-KEY");
 assert.deepEqual(seen.map(s => `${s.method} ${s.url}`), ["GET http://127.0.0.1:4321/license/status", "POST http://127.0.0.1:4321/license/trial", "POST http://127.0.0.1:4321/license/refresh", "POST http://127.0.0.1:4321/license/deactivate", "POST http://127.0.0.1:4321/license/activate"]);
 assert.ok(seen.every(s => s.headers.Authorization === "Bearer tok"));
 assert.deepEqual(seen.filter(s => s.body?.includes("SECRET-KEY")).map(s => s.url.split("/").pop()), ["activate"]);
 assert.equal(new LicenseClient(async () => null, async () => { throw new Error("must not be called"); }).status().then(r => r.code) instanceof Promise, true);
 assert.equal((await new LicenseClient(async () => null, async () => { throw new Error("x"); }).status()).code, "companion_unreachable");
 assert.equal((await new LicenseClient(async () => ({ port: 1, token: "t" } as never), async () => ({ status: 404, text: "" })).status()).code, "companion_outdated");
 assert.equal((await new LicenseClient(async () => ({ port: 1, token: "t" } as never), async () => { throw new Error("down"); }).status()).code, "companion_unreachable");
});

test("controller: unknown is not entitled, changes are reported, disconnect forgets the status", async () => {
 let changes: boolean[] = [];
 let next = reply(base);
 const controller = new LicenseController(new LicenseClient(async () => ({ port: 1, token: "t" } as never), async () => ({ status: 200, text: next })), c => changes.push(c));
 assert.equal(controller.entitled(), false, "no fail-open default");
 await controller.refreshStatus(); assert.equal(controller.entitled(), false);
 next = reply(trial(14)); await controller.act("trial"); assert.equal(controller.entitled(), true);
 assert.deepEqual(changes, [false, true]);
 controller.clear(); assert.equal(controller.entitled(), false); assert.equal(changes.at(-1), true, "clearing an entitled status counts as a change");
});

test("notices: restrained, each once, none for Pro", () => {
 assert.equal(nextLicenseNotice(null, {}), null);
 assert.equal(nextLicenseNotice(base, {}), "welcome");
 assert.equal(nextLicenseNotice(base, { welcome: true }), null);
 assert.equal(nextLicenseNotice(trial(10), {}), null, "no reminder mid-trial");
 assert.equal(nextLicenseNotice(trial(3), {}), "soon");
 assert.equal(nextLicenseNotice(trial(3), { soon: true }), null);
 assert.equal(nextLicenseNotice({ ...base, mode: "expired" }, { welcome: true, soon: true }), "expired");
 assert.equal(nextLicenseNotice({ ...base, mode: "expired" }, { expired: true }), null);
 assert.equal(nextLicenseNotice(pro, {}), null, "activation removes trial prompts");
 for (const text of Object.values(NOTICE_TEXT)) assert.doesNotMatch(text, /DevLab|beta/i);
});

test("messages are clear for every failure and never echo a key", () => {
 for (const code of ["invalid_key", "activation_limit", "wrong_product", "offline", "service_error", "invalid_lease", "license_invalid", "not_activated", "device_unavailable", "companion_unreachable", "companion_outdated"]) {
  const text = replyMessage({ ok: false, code, status: null }, "activate");
  assert.ok(text.length > 20 && !/SECRET|undefined/.test(text), code);
 }
 assert.match(replyMessage({ ok: false, code: "activation_limit", status: null }, "activate"), /activation limit/);
 assert.match(statusHeadline({ ...base, mode: "unverified", notice: "subscription_ended" }), /subscription/);
 assert.match(statusHeadline(trial(1)), /1 day remaining/);
 assert.match(statusHeadline(trial(9)), /9 days remaining/);
 assert.match(statusHeadline({ ...base, mode: "expired" }), /trial has ended/);
 assert.match(statusHeadline(base), /notes and attachments always stay available/);
 assert.equal(sidebarLicenseNote(pro), null); assert.equal(sidebarLicenseNote(trial(5)), null);
 assert.match(sidebarLicenseNote(base)!, /trial or ClingNote Pro/);
});

test("free mode stops automatic opening but never touches attachments; entitlement resumes following", async () => {
 const service = new FakeService(); const host = new FakeHost(); const mappings = new MappingStore();
 let licensed = false;
 const { follower } = makeFollower(service, host, { mappings });
 (follower as unknown as { hooks: { limited?: () => boolean } }).hooks.limited = () => !licensed;
 host.files.add("Alpha Main.md"); host.files.add("Beta Main.md");
 const a = snapshot("cmd.exe", "A", "");
 mappings.attach(a.key, "Alpha Main.md", "A");
 const before = JSON.stringify(mappings.toJSON());
 service.set(a); await follower.step();
 assert.equal(host.opened.length, 0, "free: the Main note is not opened automatically");
 assert.match(follower.statusText(), /needs a trial or Pro/);
 assert.equal(JSON.stringify(mappings.toJSON()), before, "attachments untouched");
 licensed = true; await follower.refresh();
 assert.equal(host.active, "Alpha Main.md", "once entitled the current context is followed");
 licensed = false; const b = snapshot("cmd.exe", "B", ""); mappings.attach(b.key, "Beta Main.md", "B");
 service.set(b); await follower.step();
 assert.equal(host.active, "Alpha Main.md", "expired again: no automatic switch");
 assert.ok(mappings.get(b.key) && mappings.get(a.key), "relationships survive expiry");
});

test("persisted settings keep notice flags only and never a license key", () => {
 const data = persistedData({ settings: { licenseNotices: { welcome: true, soon: "yes", licenseKey: "SECRET" }, licenseKey: "SECRET" } });
 assert.deepEqual(data.settings.licenseNotices, { welcome: true });
 assert.doesNotMatch(JSON.stringify(data), /SECRET/);
});

test("activation and explicit deactivation take effect immediately, with no polling interval involved", async () => {
 let next = reply(base);
 const changes: boolean[] = [];
 let controller!: LicenseController;
 const service = new FakeService(); const host = new FakeHost(); const mappings = new MappingStore();
 host.files.add("Alpha Main.md"); host.files.add("Beta Main.md");
 const { follower } = makeFollower(service, host, { mappings });
 (follower as unknown as { hooks: { limited?: () => boolean } }).hooks.limited = () => !controller.entitled();
 controller = new LicenseController(new LicenseClient(async () => ({ port: 1, token: "t" } as never), async () => ({ status: 200, text: next })), c => { changes.push(c); if (c) void follower.refresh(); });
 const a = snapshot("cmd.exe", "A", ""), b = snapshot("cmd.exe", "B", "");
 mappings.attach(a.key, "Alpha Main.md", "A"); mappings.attach(b.key, "Beta Main.md", "B");

 service.set(a); await follower.step();
 assert.equal(host.opened.length, 0, "free: nothing opens");
 next = reply(pro, "ok"); await controller.act("activate", "KEY");           // no timers, no waiting
 assert.equal(controller.entitled(), true, "entitled the moment the activation reply arrives");
 assert.equal(controller.status?.mode, "pro", "the settings UI reads this same state");
 assert.deepEqual(changes, [true], "listeners (status bar, sidebar, follower) were notified immediately");
 await new Promise(r => setImmediate(r));
 assert.equal(host.active, "Alpha Main.md", "the current context is followed right after activation");
 service.set(b); await follower.step();
 assert.equal(host.active, "Beta Main.md", "and following continues");

 next = reply(base, "ok"); await controller.act("deactivate");
 assert.equal(controller.entitled(), false, "not entitled the moment the deactivation reply arrives");
 assert.equal(controller.status?.mode, "free");
 assert.deepEqual(changes, [true, true], "listeners were notified immediately");
 service.set(a); await follower.step();
 assert.equal(host.active, "Beta Main.md", "no switch after deactivation");
 assert.ok(mappings.get(a.key) && mappings.get(b.key), "attachments untouched");
 // A failed deactivation must keep Pro (nothing local changes without the server's confirmation).
 next = reply(pro); await controller.act("activate", "KEY");
 next = JSON.stringify({ ok: false, code: "offline", status: pro }); await controller.act("deactivate");
 assert.equal(controller.entitled(), true, "failed deactivation keeps Pro");
});
