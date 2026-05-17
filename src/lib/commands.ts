import { invoke } from "@tauri-apps/api/core";
import type { Connection, Folder } from "../types";

// ── Connections ──────────────────────────────────────────────────────────────

export async function getConnections(): Promise<Connection[]> {
  return invoke("get_connections");
}

export async function getFolders(): Promise<Folder[]> {
  return invoke("get_folders");
}

export async function saveConnection(
  conn: Omit<Connection, "id" | "created_at" | "updated_at">
): Promise<Connection> {
  return invoke("save_connection", { conn });
}

export async function updateConnection(conn: Connection): Promise<Connection> {
  return invoke("update_connection", { conn });
}

export async function deleteConnection(id: string): Promise<void> {
  return invoke("delete_connection", { id });
}

export async function saveFolder(name: string, parentId: string | null): Promise<Folder> {
  return invoke("save_folder", { name, parentId });
}

export async function deleteFolder(id: string): Promise<void> {
  return invoke("delete_folder", { id });
}

export async function exportConnections(): Promise<string> {
  return invoke("export_connections");
}

export async function importConnections(json: string): Promise<number> {
  return invoke("import_connections", { json });
}

// ── Passwords ────────────────────────────────────────────────────────────────

export async function savePassword(connectionId: string, password: string): Promise<void> {
  return invoke("save_password", { connectionId, password });
}

export async function deletePassword(connectionId: string): Promise<void> {
  return invoke("delete_password", { connectionId });
}

export async function hasPassword(connectionId: string): Promise<boolean> {
  return invoke("has_password", { connectionId });
}

// ── SSH sessions ─────────────────────────────────────────────────────────────

export async function connectSsh(connectionId: string): Promise<string> {
  return invoke("connect_ssh", { connectionId });
}

export async function sendInput(sessionId: string, data: string): Promise<void> {
  return invoke("send_input", { sessionId, data });
}

export async function resizePty(sessionId: string, cols: number, rows: number): Promise<void> {
  return invoke("resize_pty", { sessionId, cols, rows });
}

export async function disconnectSsh(sessionId: string): Promise<void> {
  return invoke("disconnect_ssh", { sessionId });
}

// ── RDP sessions ─────────────────────────────────────────────────────────────

export async function connectRdp(connectionId: string): Promise<string> {
  return invoke("connect_rdp", { connectionId });
}

export async function rdpStatus(sessionId: string): Promise<"connected" | "disconnected"> {
  return invoke("rdp_status", { sessionId });
}

export async function disconnectRdp(sessionId: string): Promise<void> {
  return invoke("disconnect_rdp", { sessionId });
}
