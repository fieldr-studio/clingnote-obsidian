import assert from "node:assert/strict";
import { test } from "node:test";
import { MappingStore } from "../src/mappings";
import { FakeHost, FakeService, makeFollower, snapshot } from "./helpers";

const budget = snapshot("EXCEL.EXE", "Budget.xlsx - Excel", "C:\\Work\\Budget.xlsx");
const claims = snapshot("PBIDesktop.exe", "Claims.pbix", "C:\\Work\\Claims.pbix");

test("physical file keys survive move but a replacement never falls back to a path mapping", async () => {
	const { service, host, follower, mappings } = setup();
	const original = { ...snapshot("notepad.exe", "FileB.txt - Notepad", "C:\\X\\FileB.txt"), key: "file-id:test-volume:original" };
	const moved = { ...original, path: "C:\\Y\\FileB.txt" };
	const replacement = { ...original, key: "file-id:test-volume:replacement" };
	mappings.attach(original.key, "Projects/Budget Notes.md", "FileB.txt");
	mappings.attach("file:c:\\x\\fileb.txt", "Projects/Budget Notes.md", "legacy path");
	service.set(original);
	await follower.step();
	assert.equal(host.opened.length, 1);
	service.set(moved);
	await follower.step();
	assert.equal(host.opened.length, 1, "same physical identity does not reopen note");
	service.set(replacement);
	await follower.step();
	assert.equal(host.opened.length, 1, "replacement does not open original note");
	assert.equal(host.active, "Projects/Budget Notes.md", "unmapped context leaves existing note visible");
	assert.match(follower.statusText(), /\(no note\)$/);
	assert.equal(mappings.get(replacement.key), undefined);
	host.active = "Projects/Claims Notes.md";
	service.set(null);
	await follower.step();
	service.set(replacement);
	await follower.step();
	assert.equal(host.active, "Projects/Claims Notes.md", "replacement cannot actively reopen B's note");
	service.set(moved);
	await follower.step();
	assert.equal(host.active, "Projects/Budget Notes.md", "return to original still follows");
	service.set({ ...moved, path: "C:\\Y\\Renamed.txt" });
	await follower.step();
	assert.equal(host.opened.length, 2, "rename remains same logical context");
	service.set({ ...moved, key: "file-id:test-volume:recreated" });
	await follower.step();
	assert.match(follower.statusText(), /\(no note\)$/);
	assert.equal(host.opened.length, 2, "new identity after deletion does not inherit");
});

function setup() {
	const service = new FakeService();
	const host = new FakeHost();
	host.files.add("Projects/Budget Notes.md").add("Projects/Claims Notes.md");
	return { service, host, ...makeFollower(service, host) };
}

test("mappings: one key one note, replacement reported, rename and detach", () => {
	const store = new MappingStore();
	assert.equal(store.attach("k1", "a.md", "A"), undefined);
	assert.equal(store.attach("k1", "a.md", "A again"), undefined, "re-attaching the same note is not a replacement");
	assert.equal(store.entries().length, 1, "no duplicate mapping for the same key");
	assert.equal(store.attach("k1", "b.md", "A")?.notePath, "a.md", "a different note replaces and reports the old one");
	store.attach("k2", "b.md", "B");
	assert.deepEqual(store.keysForNote("b.md").sort(), ["k1", "k2"], "one note may follow several files");
	assert.equal(store.renameNote("b.md", "moved/b.md"), 2);
	assert.equal(store.get("k2")?.notePath, "moved/b.md");
	assert.equal(store.detach("k1"), true);
	assert.equal(store.detach("k1"), false);
	const copy = new MappingStore(JSON.parse(JSON.stringify(store.toJSON())));
	assert.deepEqual(copy.toJSON(), store.toJSON(), "round-trips through JSON");
	assert.equal(new MappingStore({ version: 1, mappings: { x: { notePath: "", label: "" } } }).entries().length, 0, "rejects invalid entries");
	assert.equal(new MappingStore({ version: 2 as never }).entries().length, 0, "ignores unknown versions");
});

test("attach, then switch A -> B -> A opens the right notes", async () => {
	const { service, host, follower, mappings } = setup();

	// Excel is in front; Obsidian shows Budget Notes. Attach it.
	service.set(budget);
	host.active = "Projects/Budget Notes.md";
	await follower.step();
	assert.deepEqual(host.opened, [], "nothing to open while unmapped");
	assert.equal((await follower.attachCurrentNote()).ok, true);

	// Claims: attach a different note.
	service.set(claims);
	await follower.step();
	host.active = "Projects/Claims Notes.md";
	assert.equal((await follower.attachCurrentNote()).ok, true);
	assert.equal(mappings.entries().length, 2, "two distinct mappings");

	// A -> B -> A
	host.opened.length = 0;
	service.set(budget);
	await follower.step();
	assert.deepEqual(host.opened, ["Projects/Budget Notes.md"], "back to Budget opens Budget Notes");
	service.set(claims);
	await follower.step();
	assert.deepEqual(host.opened, ["Projects/Budget Notes.md", "Projects/Claims Notes.md"], "Claims opens Claims Notes");
	service.set(budget);
	await follower.step();
	assert.equal(host.opened.at(-1), "Projects/Budget Notes.md");
	assert.equal(mappings.entries().length, 2, "switching never creates mappings");
});

test("window-only contexts (no path) map by process and normalized title", async () => {
	const { service, host, follower, mappings } = setup();
	const excel = snapshot("EXCEL.EXE", "Budget.xlsx - Excel");
	service.set(excel);
	host.active = "Projects/Budget Notes.md";
	await follower.step();
	const result = await follower.attachCurrentNote();
	assert.match(result.message, /no file path available/);
	assert.ok(mappings.get(excel.key));
	service.set(claims);
	await follower.step();
	host.active = "Projects/Claims Notes.md"; // the user is reading another note meanwhile
	service.set(excel);
	await follower.step();
	assert.equal(host.opened.at(-1), "Projects/Budget Notes.md");
});

test("an unmapped context does nothing destructive", async () => {
	const { service, host, follower, mappings } = setup();
	host.active = "Projects/Budget Notes.md";
	service.set(claims);
	await follower.step();
	assert.deepEqual(host.opened, []);
	assert.equal(host.active, "Projects/Budget Notes.md", "the note you were in is left alone");
	assert.equal(mappings.entries().length, 0);
	service.set(null); // desktop
	await follower.step();
	assert.deepEqual(host.opened, []);
});

test("a missing note is reported once and nothing is opened or removed", async () => {
	const { service, host, follower, mappings } = setup();
	mappings.attach(budget.key, "Gone/Deleted.md", "Budget.xlsx");
	service.set(budget);
	await follower.step();
	service.set(claims);
	await follower.step();
	service.set(budget);
	await follower.step();
	assert.deepEqual(host.opened, []);
	assert.equal(host.notices.length, 1, "warned only once");
	assert.ok(mappings.get(budget.key), "the mapping is kept");
});

test("the same context repeated does not reopen or fight manual navigation", async () => {
	const { service, host, follower, mappings } = setup();
	mappings.attach(budget.key, "Projects/Budget Notes.md", "Budget.xlsx");
	service.set(budget);
	await follower.step();
	assert.equal(host.opened.length, 1);
	host.active = "Other.md"; // user navigates elsewhere in Obsidian
	await follower.step(); // same seq: poll returns the unchanged state
	service.state = { ...service.state, seq: service.state.seq + 1 }; // a bump with the same key
	await follower.step();
	assert.equal(host.opened.length, 1, "no re-open for an unchanged context");
	assert.equal(host.active, "Other.md");
});

test("already showing the mapped note: no open", async () => {
	const { service, host, follower, mappings } = setup();
	mappings.attach(budget.key, "Projects/Budget Notes.md", "Budget.xlsx");
	host.active = "Projects/Budget Notes.md";
	service.set(budget);
	await follower.step();
	assert.deepEqual(host.opened, []);
});

test("detach and change attachment", async () => {
	const { service, host, follower, mappings, changes } = setup();
	service.set(budget);
	host.active = "Projects/Budget Notes.md";
	await follower.step();
	await follower.attachCurrentNote();
	host.active = "Projects/Claims Notes.md";
	const changed = await follower.attachCurrentNote();
	assert.match(changed.message, /stays attached/);
	assert.equal(mappings.get(budget.key)?.notePath, "Projects/Claims Notes.md");
	assert.equal(mappings.entries().length, 1, "still one mapping for the file");
	assert.equal((await follower.detachCurrentContext()).ok, true);
	assert.equal(mappings.entries().length, 0);
	assert.equal((await follower.detachCurrentContext()).ok, false, "detaching twice is harmless");
	assert.equal(changes.length, 3, "persistence is requested for every change");
});

test("attach needs a note and a Windows context; Obsidian focus keeps the last external file", async () => {
	const { service, host, follower } = setup();
	assert.equal((await follower.attachCurrentNote()).ok, false, "no active note");
	host.active = "Projects/Budget Notes.md";
	assert.match((await follower.attachCurrentNote()).message, /No safe context available/);
	// Obsidian focus preserves the explicit accepted target; it is not desktop/no-context.
	service.set(budget);
	service.state = { ...service.state, acceptedTarget: budget, availability: "ready" };
	const result = await follower.attachCurrentNote();
	assert.equal(result.ok, true, "uses the eligible accepted external file");
	assert.ok(follower.mappings.get(budget.key));
});

test("pausing follows nothing and resuming re-evaluates the current context", async () => {
	const service = new FakeService();
	const host = new FakeHost();
	host.files.add("Projects/Budget Notes.md");
	let follow = false;
	const { follower, mappings } = makeFollower(service, host, { follow: () => follow });
	mappings.attach(budget.key, "Projects/Budget Notes.md", "Budget.xlsx");
	service.set(budget);
	await follower.step();
	assert.deepEqual(host.opened, [], "paused");
	follow = true;
	await follower.refresh();
	assert.deepEqual(host.opened, ["Projects/Budget Notes.md"]);
});

test("a stopped service is a quiet 'disconnected' state, and the follower recovers", async () => {
	const { service, host, follower, statuses } = setup();
	follower.mappings.attach(budget.key, "Projects/Budget Notes.md", "Budget.xlsx");
	service.failing = true;
	assert.equal(await follower.step(), false, "step reports failure instead of throwing");
	assert.equal(follower.status, "disconnected");
	assert.match(follower.statusText(), /not running/);
	assert.equal((await follower.attachCurrentNote()).ok, false, "commands fail gracefully");
	service.failing = false;
	service.set(budget);
	assert.equal(await follower.step(), true);
	assert.equal(follower.status, "connected");
	assert.deepEqual(host.opened, ["Projects/Budget Notes.md"], "resynchronises and follows after reconnecting");
	assert.deepEqual(statuses, ["disconnected", "connected"]);
});


test("follow diagnostics record why each context did or did not open a note, without raw identifiers", async () => {
	const { service, host, follower, mappings } = setup();
	mappings.attach(budget.key, "Projects/Budget Notes.md", "Budget");
	service.set(budget); await follower.step();
	service.set(claims); await follower.step();
	service.set(null); await follower.step();
	const outcomes = follower.decisions.map(d => d.outcome);
	assert.deepEqual(outcomes, ["opened attached note", "no note attached", "waiting: none"]);
	assert.equal(host.opened.length, 1);
	const text = follower.diagnosticsText();
	assert.match(text, /key=other/);
	assert.doesNotMatch(text, /Budget|Claims|C:\Work/i, "diagnostics never include titles, paths or keys");
});
