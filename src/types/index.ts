export type ConnectionType = "ssh" | "rdp" | "vnc" | "ftp" | "sftp";
export type AuthType = "agent" | "password" | "key";
export type ConnectionStatus = "idle" | "connecting" | "connected" | "error";

export interface Group {
  id: string;
  name: string;
}

export interface Connection {
  id: string;
  name: string;
  type: ConnectionType;
  host: string;
  port: number;
  username: string;
  auth_type: AuthType;
  key_path: string;
  folder_id: string | null;
  notes: string;
  description: string;
  domain: string;
  rdp_admin: boolean;
  created_at: string;
  updated_at: string;
  sort_order: number;
  group_id: string;
  icon: string;
}

export interface Folder {
  id: string;
  name: string;
  parent_id: string | null;
  expanded: boolean;
  group_id: string;
}

export interface Tab {
  id: string;
  connection_id: string;
  connection_name: string;
  connection_type: ConnectionType;
  status: ConnectionStatus;
  session_id?: string;
  icon?: string;
}

export interface SftpEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  modified: number;
}
