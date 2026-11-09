/** ClingNote accent color: a presentation preference scoped to ClingNote's own elements (never Obsidian's theme). */
export const ACCENT_PRESETS: ReadonlyArray<{ name: string; value: string }> = [
    { name: "Blue", value: "#3b82f6" }, { name: "Teal", value: "#14b8a6" }, { name: "Green", value: "#22c55e" },
    { name: "Amber", value: "#f59e0b" }, { name: "Orange", value: "#f97316" }, { name: "Red", value: "#ef4444" },
    { name: "Pink", value: "#ec4899" }, { name: "Slate", value: "#64748b" },
];

export function normalizeAccent(value: unknown): string | undefined {
    return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value.trim()) ? value.trim().toLowerCase() : undefined;
}
function channels(hex: string): [number, number, number] {
    return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}
function luminance([r, g, b]: [number, number, number]): number {
    const lin = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
export function contrast(a: string, b: string): number {
    const [la, lb] = [luminance(channels(a)), luminance(channels(b))];
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
const toHex = (c: [number, number, number]) => "#" + c.map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");
function mix(hex: string, target: [number, number, number], amount: number): string {
    const c = channels(hex);
    return toHex([0, 1, 2].map(i => c[i] + (target[i] - c[i]) * amount) as [number, number, number]);
}

/**
 * The chosen accent is used for fills and tints as is. For text and icons it is nudged toward black (light theme) or white (dark
 * theme) until it reaches at least 4.5:1 against the theme's background, so any picked color stays readable.
 */
export function accentColors(accent: string, dark: boolean): { fill: string; text: string; onFill: string } {
    const background = dark ? "#1e1e1e" : "#f5f6f8";
    const toward: [number, number, number] = dark ? [255, 255, 255] : [0, 0, 0];
    let text = accent;
    for (let step = 0; step < 20 && contrast(text, background) < 4.5; step++) text = mix(text, toward, 0.1);
    const onFill = contrast("#ffffff", accent) >= contrast("#000000", accent) ? "#ffffff" : "#000000";
    return { fill: accent, text, onFill };
}
