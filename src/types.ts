/** Wire types of the ClingNote.Context local API (see ClingNote.Context/ContextSnapshot.cs). */
export interface ContextSnapshot {
	/** "file" when ClingNote has a trusted path, otherwise "window". */
	type: "file" | "window";
	/** Live keys: file-id:<volume>:<serial>:<id>, url:<page identity>, or window:<process>|<TITLE>. */
	key: string;
	path: string | null;
	process: string;
	title: string;
	pathSource: string;
	hwnd: number;
	pid: number;
}

export interface ContextState {
    /** Authoritative companion contract. Legacy fields below are compatibility aliases. */
    acceptedTarget?: ContextSnapshot | null;
    availability?: "ready" | "none" | "private" | "privacy-unknown" | "identity-unavailable" | null;
    pauseDetail?: "confirmed-private" | "verifying-context" | null;
	pauseReason: "private-browsing" | null;
	seq: number;
	current: ContextSnapshot | null;
	lastExternal: ContextSnapshot | null;
}

export interface Endpoint {
	protocolMajor?: number;
	protocolMinor?: number;
	version?: string;
	port: number;
	token: string;
	pid?: number;
	testMode?: boolean;
}

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

export interface NoteMapping {
	/** Vault-relative path of the attached Markdown note. */
	notePath: string;
	/** Human label of the Windows file/window at attach time (display only; never used for matching). */
	label: string;
	navigation?: NavigationTarget;
    /** Full group snapshots in activity history; absent in legacy entries. */
    relatedNotes?: string[];
    header?: GroupHeader;
    /** Display icon of the context: "lucide:<name>" or "emoji:<chars>". Never affects identity. */
    icon?: string;
}

export type GroupHeader = { mode: "context" } | { mode: "hidden" } | { mode: "custom"; label: string };
export interface ContextGroup {
    mainNote: string;
    relatedNotes: string[];
    label: string;
    header: GroupHeader;
    navigation?: NavigationTarget;
    /** Optional display icon, "lucide:<name>" or "emoji:<chars>" (absent = default for the context kind). */
    icon?: string;
}

export type NavigationTarget = { kind: "file" | "folder"; path: string; stamp: string } | { kind: "page"; url: string };
export interface MappingActivity {
	id: number; at: number; key: string; before?: NoteMapping; after?: NoteMapping; undoable: boolean;
}
export type PauseState = { kind: "timed"; until: number } | { kind: "restart"; session: string } | { kind: "indefinite" };

export interface LegacyMappingData {
	version: 1;
	mappings: Record<string, NoteMapping>;
	activity?: MappingActivity[];
}
export interface GroupData {
    version: 2;
    groups: Record<string, ContextGroup>;
    activity?: MappingActivity[];
}
export type MappingData = LegacyMappingData | GroupData;

export interface ClingNoteSettings {
	followEnabled: boolean;
	/** Empty = default (%LOCALAPPDATA%\ClingNote.Context\endpoint.json). */
	endpointFile: string;
	showStatusBar: boolean;
	pause?: PauseState;
	showUnmappedHint?: boolean;
	/** Which one-time license notices were already shown. Contains no license data. */
	licenseNotices?: { welcome?: boolean; soon?: boolean; expired?: boolean };
	/** Sidebar presentation state only (0.17). Safe to lose; never affects attachments. */
	ui?: SidebarUiState;
}

export interface SidebarUiState {
	/** Context keys the user collapsed. Everything else is expanded. */
	collapsed: string[];
	/** The Unattached section is collapsed unless the user opened it. */
	unattachedExpanded: boolean;
	sort: "created" | "name";
	/** Optional ClingNote accent as #rrggbb. Absent = Obsidian's own accent. */
	accent?: string;
	/** True once the sidebar tab has been auto-selected (or deliberately left alone) on a first launch. */
	sidebarActivated?: boolean;
}

export const DEFAULT_SETTINGS: ClingNoteSettings = {
	followEnabled: true,
	endpointFile: "",
	showStatusBar: true,
	showUnmappedHint: true,
};

/** Companion protocol major this plugin understands; unknown majors are refused by the client. */
export const SUPPORTED_PROTOCOL_MAJOR = 1;
