import { invoke } from "@tauri-apps/api/core";
import type { Connection, Folder } from "../types";

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

export async function saveFolder(
  name: string,
  parentId: string | null
): Promise<Folder> {
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
