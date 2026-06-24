import { invoke } from "@tauri-apps/api/core";
import type { Connection, Folder, Group, SftpEntry } from "../types";

// ── Connections ──────────────────────────────────────────────────────────────

export async function getConnections(): Promise<Connection[]> {
  return invoke("get_connections");
}

export async function getFolders(): Promise<Folder[]> {
  return invoke("get_folders");
}

export async function saveConnection(
  conn: Omit<Connection, "id" | "created_at" | "updated_at" | "sort_order">
): Promise<Connection> {
  return invoke("save_connection", { conn });
}

export async function updateConnection(conn: Connection): Promise<Connection> {
  return invoke("update_connection", { conn });
}

export async function deleteConnection(id: string): Promise<void> {
  return invoke("delete_connection", { id });
}

export async function saveFolder(name: string, parentId: string | null, groupId?: string | null): Promise<Folder> {
  return invoke("save_folder", { name, parentId, groupId: groupId ?? null });
}

export async function updateFolder(id: string, name: string, description: string, color: string): Promise<void> {
  return invoke("update_folder", { id, name, description, color });
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

export async function exportToFile(path: string): Promise<void> {
  return invoke("export_to_file", { path });
}

export async function importFromFile(path: string): Promise<number> {
  return invoke("import_from_file", { path });
}

export async function exportSelectedToFile(
  groupIds: string[],
  includePasswords: boolean,
  path: string,
): Promise<number> {
  return invoke("export_selected_to_file", { groupIds, includePasswords, path });
}

// Fire-and-forget: the import runs on a background thread in Rust and reports
// via the mrng-import-progress / mrng-import-done / mrng-import-error events.
export async function importFromMremoteng(path: string, password?: string): Promise<void> {
  return invoke("import_from_mremoteng", { path, password: password ?? null });
}

export async function reorderConnections(
  updates: { id: string; sort_order: number; folder_id: string | null; group_id: string }[],
): Promise<void> {
  return invoke("reorder_connections", { updates });
}

export async function reorderFolders(
  updates: { id: string; sort_order: number; parent_id: string | null; group_id: string }[],
): Promise<void> {
  return invoke("reorder_folders", { updates });
}

export async function moveFolderToGroup(folderId: string, targetGroupId: string): Promise<void> {
  return invoke("move_folder_to_group", { folderId, targetGroupId });
}

// ── Groups ────────────────────────────────────────────────────────────────────

export async function getGroups(): Promise<Group[]> {
  return invoke("get_groups");
}

export async function saveGroup(name: string): Promise<Group> {
  return invoke("save_group", { name });
}

export async function renameGroup(id: string, name: string): Promise<void> {
  return invoke("rename_group", { id, name });
}

export async function updateGroup(id: string, name: string, description: string, color: string): Promise<void> {
  return invoke("update_group", { id, name, description, color });
}

export async function deleteGroup(id: string): Promise<void> {
  return invoke("delete_group", { id });
}

// ── Passwords ────────────────────────────────────────────────────────────────

export async function savePassword(connectionId: string, password: string): Promise<void> {
  return invoke("save_password", { connectionId, password });
}

export async function deletePassword(connectionId: string): Promise<void> {
  return invoke("delete_password", { connectionId });
}

export async function getPassword(connectionId: string): Promise<string> {
  return invoke("get_password", { connectionId });
}

// ── Per-data-source master password (view lock) ──────────────────────────────
export async function groupMasterStatus(groupId: string): Promise<boolean> {
  return invoke("group_master_status", { groupId });
}
export async function groupMasterCreate(groupId: string, password: string): Promise<void> {
  return invoke("group_master_create", { groupId, password });
}
export async function groupMasterChange(groupId: string, oldPassword: string, newPassword: string): Promise<void> {
  return invoke("group_master_change", { groupId, oldPassword, newPassword });
}
export async function groupMasterVerify(groupId: string, password: string): Promise<boolean> {
  return invoke("group_master_verify", { groupId, password });
}

export async function hasPassword(connectionId: string): Promise<boolean> {
  return invoke("has_password", { connectionId });
}

export async function copyPassword(fromId: string, toId: string): Promise<void> {
  return invoke("copy_password", { fromId, toId });
}

// ── SSH sessions ─────────────────────────────────────────────────────────────

// Returns the session id. Rejects with "NEED_CREDENTIALS" when a username or
// password is required (no saved credentials) — the caller should prompt and
// retry with `username` / `password` filled in.
export async function connectSsh(
  connectionId: string,
  username?: string,
  password?: string,
): Promise<string> {
  return invoke("connect_ssh", {
    connectionId,
    username: username ?? null,
    password: password ?? null,
  });
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

export interface RdpConnectResult {
  session_id: string;
  embedded: boolean;
  native_window: boolean; // true = Windows mstsc reparented
  width: number;
  height: number;
}

export async function connectRdp(
  connectionId: string,
  width = 1280,
  height = 800,
  adminMode = false,
  canvasX = 0,
  canvasY = 0,
): Promise<RdpConnectResult> {
  return invoke("connect_rdp", { connectionId, width, height, adminMode, canvasX, canvasY });
}

export async function rdpWindowsReposition(
  sessionId: string,
  x: number,
  y: number,
  width: number,
  height: number,
): Promise<void> {
  return invoke("rdp_windows_reposition", { sessionId, x, y, width, height });
}

export async function rdpWindowsVisibility(sessionId: string, visible: boolean): Promise<void> {
  return invoke("rdp_windows_visibility", { sessionId, visible });
}

// Show a native Win32 popup menu at the given physical screen coordinates.
// Returns "reconnect" | "close" or null if dismissed.  On non-Windows this
// always returns null; the caller should fall back to the CSS context menu.
export async function showRdpTabMenu(x: number, y: number): Promise<string | null> {
  return invoke("show_rdp_tab_menu", { x, y });
}

/** Carve a hole in the RDP WS_POPUP so an HTML menu shows through without hiding the RDP.
 *  `rect` = [vp_x, vp_y, vp_w, vp_h] in WebView2 viewport coords; null clears the hole. */
export async function rdpWindowsSetMenuRegion(
  sessionId: string,
  rect: [number, number, number, number] | null,
): Promise<void> {
  return invoke("rdp_windows_set_menu_region", { sessionId, rect });
}

export async function rdpWindowsReparent(
  sessionId: string,
  x: number,
  y: number,
  width: number,
  height: number,
): Promise<void> {
  return invoke("rdp_windows_reparent", { sessionId, x, y, width, height });
}

export async function rdpResizeSession(sessionId: string, width: number, height: number): Promise<void> {
  return invoke("rdp_resize_session", { sessionId, width, height });
}

export async function rdpRefreshSession(sessionId: string): Promise<void> {
  return invoke("rdp_refresh_session", { sessionId });
}

export async function rdpStatus(sessionId: string): Promise<"connected" | "disconnected"> {
  return invoke("rdp_status", { sessionId });
}

export async function disconnectRdp(sessionId: string): Promise<void> {
  return invoke("disconnect_rdp", { sessionId });
}

export async function rdpMouseInput(
  sessionId: string,
  flags: number,
  x: number,
  y: number,
): Promise<void> {
  return invoke("rdp_mouse_input", { sessionId, flags, x, y });
}

export async function rdpKeyInput(
  sessionId: string,
  pressed: boolean,
  code: string,
): Promise<void> {
  return invoke("rdp_key_input", { sessionId, pressed, code });
}

export async function rdpGetLinuxClipboard(): Promise<string> {
  return invoke("rdp_get_linux_clipboard");
}

export async function rdpSetClipboard(sessionId: string, text: string): Promise<void> {
  return invoke("rdp_set_clipboard", { sessionId, text });
}

// ── SFTP sessions ─────────────────────────────────────────────────────────────

export async function sftpConnect(connectionId: string): Promise<string> {
  return invoke("sftp_connect", { connectionId });
}

// Reuse an existing interactive SSH session's connection for SFTP (shared
// auth — no separate login).
export async function sftpConnectFromSsh(sshSessionId: string): Promise<string> {
  return invoke("sftp_connect_from_ssh", { sshSessionId });
}

export async function sftpListDir(sessionId: string, path: string): Promise<SftpEntry[]> {
  return invoke("sftp_list_dir", { sessionId, path });
}

export async function sftpUpload(
  sessionId: string,
  localPath: string,
  remotePath: string,
): Promise<void> {
  return invoke("sftp_upload", { sessionId, localPath, remotePath });
}

export async function sftpMkdir(sessionId: string, path: string): Promise<void> {
  return invoke("sftp_mkdir", { sessionId, path });
}

export async function sftpDownload(
  sessionId: string,
  remotePath: string,
  localPath: string,
): Promise<void> {
  return invoke("sftp_download", { sessionId, remotePath, localPath });
}

export async function sftpRename(
  sessionId: string,
  oldPath: string,
  newPath: string,
): Promise<void> {
  return invoke("sftp_rename", { sessionId, oldPath, newPath });
}

export async function sftpChmod(sessionId: string, path: string, mode: number): Promise<void> {
  return invoke("sftp_chmod", { sessionId, path, mode });
}

export async function sftpCreateFile(sessionId: string, path: string): Promise<void> {
  return invoke("sftp_create_file", { sessionId, path });
}

export async function sftpDelete(
  sessionId: string,
  path: string,
  isDir: boolean,
): Promise<void> {
  return invoke("sftp_delete", { sessionId, path, isDir });
}

export async function sftpDisconnect(sessionId: string): Promise<void> {
  return invoke("sftp_disconnect", { sessionId });
}

// ── Local filesystem ──────────────────────────────────────────────────────────

export interface LocalEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  modified: number;
}

export async function localListDir(path: string): Promise<LocalEntry[]> {
  return invoke("local_list_dir", { path });
}

export async function localGetHome(): Promise<string> {
  return invoke("local_get_home");
}

export async function localGetParent(path: string): Promise<string> {
  return invoke("local_get_parent", { path });
}

export async function localMkdir(path: string): Promise<void> {
  return invoke("local_mkdir", { path });
}

export async function localDelete(path: string, isDir: boolean): Promise<void> {
  return invoke("local_delete", { path, isDir });
}

// ── FTP sessions ───────────────────────────────────────────────────────────────

export interface FtpEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  modified: string;
}

export async function ftpConnect(connectionId: string): Promise<string> {
  return invoke("ftp_connect", { connectionId });
}

export async function ftpListDir(sessionId: string, path: string): Promise<FtpEntry[]> {
  return invoke("ftp_list_dir", { sessionId, path });
}

export async function ftpUpload(
  sessionId: string,
  localPath: string,
  remotePath: string,
): Promise<void> {
  return invoke("ftp_upload", { sessionId, localPath, remotePath });
}

export async function ftpDownload(
  sessionId: string,
  remotePath: string,
  localPath: string,
): Promise<void> {
  return invoke("ftp_download", { sessionId, remotePath, localPath });
}

export async function ftpMkdir(sessionId: string, path: string): Promise<void> {
  return invoke("ftp_mkdir", { sessionId, path });
}

export async function ftpDelete(
  sessionId: string,
  path: string,
  isDir: boolean,
): Promise<void> {
  return invoke("ftp_delete", { sessionId, path, isDir });
}

export async function ftpRename(
  sessionId: string,
  oldPath: string,
  newPath: string,
): Promise<void> {
  return invoke("ftp_rename", { sessionId, oldPath, newPath });
}

export async function ftpPwd(sessionId: string): Promise<string> {
  return invoke("ftp_pwd", { sessionId });
}

export async function ftpDisconnect(sessionId: string): Promise<void> {
  return invoke("ftp_disconnect", { sessionId });
}

// ── VNC sessions ───────────────────────────────────────────────────────────────

export interface VncConnectResult {
  session_id: string;
  width: number;
  height: number;
}

export async function vncConnect(connectionId: string): Promise<VncConnectResult> {
  return invoke("vnc_connect", { connectionId });
}

export async function vncKeyEvent(
  sessionId: string,
  down: boolean,
  key: number,
): Promise<void> {
  return invoke("vnc_key_event", { sessionId, down, key });
}

export async function vncPointerEvent(
  sessionId: string,
  buttons: number,
  x: number,
  y: number,
): Promise<void> {
  return invoke("vnc_pointer_event", { sessionId, buttons, x, y });
}

export async function vncSendClipboard(sessionId: string, text: string): Promise<void> {
  return invoke("vnc_send_clipboard", { sessionId, text });
}

export async function vncDisconnect(sessionId: string): Promise<void> {
  return invoke("vnc_disconnect", { sessionId });
}

// ── Browser ───────────────────────────────────────────────────────────────────

export async function browserOpen(connectionId: string): Promise<number> {
  return invoke("browser_open", { connectionId });
}

export async function browserClose(connectionId: string): Promise<void> {
  return invoke("browser_close", { connectionId });
}

// ── Window management ─────────────────────────────────────────────────────────

export async function getWindowLabel(): Promise<string> {
  return invoke("get_window_label");
}

export async function openDetachedWindow(connectionId: string, title: string): Promise<void> {
  return invoke("open_detached_window", { connectionId, title });
}

export async function storeDetachedSession(label: string, sessionId: string): Promise<void> {
  return invoke("store_detached_session", { label, sessionId });
}

export async function popDetachedSession(label: string): Promise<string | null> {
  return invoke("pop_detached_session", { label });
}

export async function dockBack(connectionId: string, sessionId: string | null): Promise<void> {
  return invoke("dock_back", { connectionId, sessionId });
}

export async function notifyDropZone(active: boolean, connectionId?: string | null): Promise<void> {
  return invoke("notify_drop_zone", { active, connectionId: connectionId ?? null });
}
