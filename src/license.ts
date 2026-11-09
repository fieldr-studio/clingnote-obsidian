import type { Endpoint } from "./types";
import type { HttpRequest } from "./transport";

/**
 * Licensing is owned by the companion (signed lease verification, protected storage, Worker calls). The plugin only displays state
 * and sends the user's explicit actions to the local companion. It never stores a license key and never decides Pro by itself.
 */
export type LicenseMode = "free" | "trial" | "pro" | "expired" | "unverified";
export interface LicenseStatus {
    mode: LicenseMode;
    entitled: boolean;
    trialStartedUtc: string | null;
    trialEndsUtc: string | null;
    trialDaysRemaining: number | null;
    leaseExpiresUtc: string | null;
    notice: string | null;
}
export interface LicenseReply { ok: boolean; code: string; status: LicenseStatus | null }

/** ClingNote Pro checkout link supplied by the owner (2026-11-09). Opened only by an explicit click. */
export const PURCHASE_URL = "https://clingnote.lemonsqueezy.com/checkout/buy/7eca1332-2e7c-4c84-8a2b-0b1b99c3efab";
export const TRIAL_REMINDER_DAYS = 3;

const MODES: readonly string[] = ["free", "trial", "pro", "expired", "unverified"];
function isStatus(value: unknown): value is LicenseStatus {
    if (typeof value !== "object" || value === null) return false;
    const v = value as Record<string, unknown>;
    return typeof v.mode === "string" && MODES.includes(v.mode) && typeof v.entitled === "boolean" &&
        // entitlement can only come from a trial or Pro; anything else claiming entitlement is rejected as malformed
        (!v.entitled || v.mode === "trial" || v.mode === "pro");
}

export function parseReply(text: string): LicenseReply | null {
    try {
        const body = JSON.parse(text) as { ok?: unknown; code?: unknown; status?: unknown };
        if (typeof body.ok !== "boolean" || typeof body.code !== "string" || body.code.length > 40) return null;
        return { ok: body.ok, code: body.code, status: isStatus(body.status) ? body.status : null };
    } catch { return null; }
}

export class LicenseClient {
    constructor(private readonly readEndpoint: () => Promise<Endpoint | null>, private readonly request: HttpRequest) {}

    status(): Promise<LicenseReply> { return this.call("GET", "/license/status"); }
    startTrial(): Promise<LicenseReply> { return this.call("POST", "/license/trial"); }
    refresh(): Promise<LicenseReply> { return this.call("POST", "/license/refresh"); }
    deactivate(): Promise<LicenseReply> { return this.call("POST", "/license/deactivate"); }
    /** The key travels only in this one local request body; it is not logged, stored or returned. */
    activate(licenseKey: string): Promise<LicenseReply> { return this.call("POST", "/license/activate", JSON.stringify({ licenseKey })); }

    private async call(method: "GET" | "POST", path: string, body?: string): Promise<LicenseReply> {
        try {
            const endpoint = await this.readEndpoint();
            if (!endpoint || !Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535 || typeof endpoint.token !== "string" || !endpoint.token)
                return { ok: false, code: "companion_unreachable", status: null };
            const response = await this.request(method, `http://127.0.0.1:${endpoint.port}${path}`, { Authorization: `Bearer ${endpoint.token}` }, body ?? (method === "POST" ? "{}" : undefined));
            if (response.status === 404) return { ok: false, code: "companion_outdated", status: null };
            return parseReply(response.text) ?? { ok: false, code: "companion_unreachable", status: null };
        } catch { return { ok: false, code: "companion_unreachable", status: null }; }
    }
}

export function statusHeadline(status: LicenseStatus | null): string {
    if (!status) return "License status unavailable. Connect the companion to see it.";
    switch (status.mode) {
        case "pro": return "ClingNote Pro is active.";
        case "trial": {
            const days = status.trialDaysRemaining ?? 0;
            return `Trial active: ${days} ${days === 1 ? "day" : "days"} remaining.`;
        }
        case "expired": return "Your 14-day trial has ended. Activate a license to keep automatic following.";
        case "unverified": return status.notice === "subscription_ended"
            ? "Your subscription appears to have ended. Renew it, or refresh once it is active again."
            : "Unable to verify your license right now. Check your connection and refresh.";
        default: return "Free. Automatic following needs a trial or ClingNote Pro. Your notes and attachments always stay available.";
    }
}

const MESSAGES: Record<string, string> = {
    invalid_key: "That license key was not recognized. Check it and try again.",
    activation_limit: "This license has reached its activation limit. Deactivate it on another computer or app, then try again.",
    wrong_product: "That key belongs to a different product.",
    offline: "Could not reach the ClingNote license service. Check your connection and try again.",
    service_error: "The license service returned an unexpected answer. Try again later.",
    invalid_lease: "The license response could not be verified, so nothing was changed.",
    license_invalid: "This license is no longer valid. If your subscription ended, renew it.",
    not_activated: "No license is activated here.",
    device_unavailable: "This computer could not be identified, so a trial cannot be started.",
    invalid_request: "The request was not accepted. Update the companion and the plugin.",
    already_started: "A trial was already started on this computer.",
    companion_unreachable: "The companion is not connected. Start it, then try again.",
    companion_outdated: "Update the ClingNote companion to use licensing.",
    not_due: "Your license is up to date.",
};
export function replyMessage(reply: LicenseReply, action: "trial" | "activate" | "deactivate" | "refresh"): string {
    if (reply.ok) {
        if (action === "trial") return reply.status?.mode === "expired" ? "A trial was already used on this computer and has ended." : "Your 14-day trial is active.";
        if (action === "activate") return "ClingNote Pro is active. Thank you.";
        if (action === "deactivate") return "License deactivated on this installation.";
        return MESSAGES[reply.code] ?? "License status refreshed.";
    }
    return MESSAGES[reply.code] ?? "The license action did not complete.";
}

export type LicenseNoticeKind = "welcome" | "soon" | "expired";
export interface LicenseNoticeFlags { welcome?: boolean; soon?: boolean; expired?: boolean }
/** At most one restrained notice, each shown once per computer profile. Active Pro never gets trial prompts. */
export function nextLicenseNotice(status: LicenseStatus | null, flags: LicenseNoticeFlags): LicenseNoticeKind | null {
    if (!status || status.mode === "pro") return null;
    if ((status.mode === "expired" || status.mode === "unverified") && !flags.expired) return "expired";
    if (status.mode === "trial" && (status.trialDaysRemaining ?? 99) <= TRIAL_REMINDER_DAYS && !flags.soon) return "soon";
    if (status.mode === "free" && !flags.welcome) return "welcome";
    return null;
}
export const NOTICE_TEXT: Record<LicenseNoticeKind, string> = {
    welcome: "ClingNote: try automatic following free for 14 days. No card needed. Start it in Settings, ClingNote.",
    soon: "ClingNote: your trial ends in a few days. Your notes and attachments stay available either way.",
    expired: "ClingNote: automatic following is off. Activate ClingNote Pro in Settings to turn it back on. Your notes are untouched.",
};

/** One small sidebar line when following is unavailable only because of the license. */
export function sidebarLicenseNote(status: LicenseStatus | null): string | null {
    if (!status || status.entitled) return null;
    if (status.mode === "free") return "Automatic following needs a free trial or ClingNote Pro.";
    if (status.mode === "expired") return "Trial ended. Automatic following is off.";
    return "License could not be verified. Automatic following is off.";
}

export class LicenseController {
    status: LicenseStatus | null = null;
    /** The connected companion has no license routes (older version). */
    outdated = false;
    private inFlight = 0;
    constructor(readonly client: LicenseClient, private readonly onChange: (entitledChanged: boolean) => void) {}

    /** Unknown means not entitled: there is no fail-open default. */
    entitled(): boolean { return this.status?.entitled === true; }

    clear(): void { if (this.status) { const was = this.entitled(); this.status = null; this.onChange(was); } }

    async refreshStatus(): Promise<LicenseReply> { return this.apply(await this.client.status()); }
    async act(action: "trial" | "activate" | "deactivate" | "refresh", key?: string): Promise<LicenseReply> {
        this.inFlight++;
        try {
            const reply = action === "trial" ? await this.client.startTrial() : action === "activate" ? await this.client.activate(key ?? "") :
                action === "deactivate" ? await this.client.deactivate() : await this.client.refresh();
            return this.apply(reply);
        } finally { this.inFlight--; }
    }
    get busy(): boolean { return this.inFlight > 0; }

    private apply(reply: LicenseReply): LicenseReply {
        const was = this.entitled();
        this.outdated = reply.code === "companion_outdated";
        if (reply.status) this.status = reply.status;
        else if (reply.code === "companion_unreachable" || reply.code === "companion_outdated") this.status = null;
        this.onChange(was !== this.entitled());
        return reply;
    }
}
