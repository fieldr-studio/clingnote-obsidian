import { createHmac, randomBytes } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { ContextState } from "./types";

let until = 0;
let salt = randomBytes(32);
declare const __CLINGNOTE_TRACE_FILE__: string;
const defaultFile = typeof __CLINGNOTE_TRACE_FILE__ === "undefined" ? "" : __CLINGNOTE_TRACE_FILE__;
let traceFile = "";
let writes: Promise<void> = Promise.resolve();
let warned = false;
export function flushContextDiagnostics(): Promise<void> { return writes; }
export function startContextDiagnostics(file = defaultFile): void {
    traceFile = file;
    warned = false;
    if (file) writes = writes.then(() => mkdir(dirname(file), { recursive: true })).then(() => undefined).catch(reportFailure);
    salt = randomBytes(32);
    until = performance.now() + 120_000;
    traceContext("trace-start", null);
}
function reportFailure(): void {
    if (!warned) { warned = true; console.warn("ClingNote: diagnostic file write failed; following is unchanged."); }
}
/** Temporary diagnostics; no raw keys, labels, paths, or persistent settings. */
export function traceContext(event: string, state: ContextState | null, keys: {
    mappingKey?: string; statusKey?: string; notePath?: string; renderedText?: string;
} = {}): void {
    if (performance.now() >= until) return;
    const hash = (value?: string | null) => value == null ? null : createHmac("sha256", salt).update(value).digest("hex").slice(0, 12).toUpperCase();
    const line = JSON.stringify({ time: new Date().toISOString(), elapsedMs: performance.now(), event,
        seq: state?.seq, current: hash(state?.current?.key), lastExternal: hash(state?.lastExternal?.key),
        title: hash(state?.current?.title), pause: state?.pauseReason,
        mappingKey: hash(keys.mappingKey), statusKey: hash(keys.statusKey), statusTitle: keys.statusKey ? hash(state?.current?.title) : null,
        note: hash(keys.notePath), renderedText: hash(keys.renderedText) });
    console.debug("ClingNoteTrace", line);
    if (traceFile) { const file = traceFile; writes = writes.then(() => appendFile(file, line + "\n", "utf8")).catch(reportFailure); }
}
// Automatic file tracing exists only in the explicitly requested diagnostic bundle.
if (defaultFile) startContextDiagnostics();
