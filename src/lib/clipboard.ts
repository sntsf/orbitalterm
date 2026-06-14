import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";

// Native (Tauri) clipboard access — unlike navigator.clipboard it never
// triggers the WebView's "allow clipboard?" permission prompt.

export async function clipboardWrite(text: string): Promise<void> {
  try { await writeText(text); } catch { /* ignore */ }
}

export async function clipboardRead(): Promise<string> {
  try { return (await readText()) ?? ""; } catch { return ""; }
}
