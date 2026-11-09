import type { ContextState, Endpoint } from "./types";
import { SUPPORTED_PROTOCOL_MAJOR } from "./types";
import { traceContext } from "./diagnostics";
import { contextState } from "./validation";

/** Minimal HTTP seam: desktop production uses bounded Node loopback HTTP. Returns non-2xx for client validation. */
export type HttpGet = (url: string, headers: Record<string, string>, signal?: AbortSignal) => Promise<{ status: number; text: string }>;

/** Reads endpoint.json (written by ClingNote.Context). Returns null when the service is not running. */
export type ReadEndpoint = () => Promise<Endpoint | null>;

export class ConnectionError extends Error {
	constructor(message: string, public readonly reason?: "missing" | "installed") {
		super(message);
		this.name = "ConnectionError";
	}
}

/**
 * Talks to the local ClingNote context service. The endpoint (random port + session token) is re-read on
 * every request after a failure, so a restarted service, or a stale file from a crashed one, heals itself.
 */
export class ContextClient {
	private endpoint: Endpoint | null = null;
	private generation = 0;
	private readonly pending = new Set<AbortController>();
	invalidate(): void {
        this.endpoint = null; this.generation++;
        for (const controller of this.pending) controller.abort();
        this.pending.clear();
    }

	constructor(
		private readonly readEndpoint: ReadEndpoint,
		private readonly http: HttpGet,
		private readonly allowTestMode = false,
	) {}

	/** Current state immediately. */
	getState(): Promise<ContextState> {
		return this.request("/context");
	}

	/** Resolves when seq != since, or after timeoutMs with the unchanged state. */
	poll(since: number, timeoutMs: number): Promise<ContextState> {
		return this.request(`/context?since=${since}&timeoutMs=${timeoutMs}`);
	}

	private async request(path: string): Promise<ContextState> {
		const generation = this.generation;
		if (!this.endpoint) {
			const endpoint = await this.readEndpoint();
			if (generation !== this.generation) throw new ConnectionError("Connection changed.");
			this.endpoint = endpoint;
			if (!this.endpoint) throw new ConnectionError("ClingNote context service is not running (no endpoint file).");
		}
		const controller = new AbortController();
        this.pending.add(controller);
		try {
			if (!Number.isInteger(this.endpoint.port) || this.endpoint.port < 1 || this.endpoint.port > 65535 ||
                typeof this.endpoint.token !== "string" || !this.endpoint.token || this.endpoint.token.length > 512 ||
                (this.endpoint.testMode !== undefined && typeof this.endpoint.testMode !== "boolean"))
				throw new ConnectionError("Invalid endpoint file.");
			if (this.endpoint.testMode && !this.allowTestMode) throw new ConnectionError("Refusing a test-mode companion for normal use.");
            // Pre-protocol manual betas remain compatible; explicit unknown major versions fail closed.
            if (this.endpoint.protocolMajor !== undefined && this.endpoint.protocolMajor !== SUPPORTED_PROTOCOL_MAJOR)
                throw new ConnectionError("Incompatible companion protocol. Install the latest companion.");
			const response = await this.http(`http://127.0.0.1:${this.endpoint.port}${path}`, {
				Authorization: `Bearer ${this.endpoint.token}`,
			}, controller.signal);
			if (generation !== this.generation) throw new ConnectionError("Connection changed.");
			if (response.status === 401 || response.status === 403) {
				this.endpoint = null; // token/port changed (service restarted): re-read next time
				throw new ConnectionError(`ClingNote context service refused the request (${response.status}).`);
			}
			if (response.status !== 200) throw new ConnectionError(`Unexpected status ${response.status} from the context service.`);
			if (response.text.length > 1048576) throw new ConnectionError("Context response exceeds the size limit.");
			const state: unknown = JSON.parse(response.text);
			if (!contextState(state))
				throw new ConnectionError("Incompatible context service. Install the latest companion.");
            traceContext("http-received", state);
            return state;
		} catch (error) {
			if (generation === this.generation) this.endpoint = null;
			if (error instanceof ConnectionError) throw error;
			throw new ConnectionError(`Could not reach the ClingNote context service: ${(error as Error).message}`);
		} finally { this.pending.delete(controller); }
	}
}
