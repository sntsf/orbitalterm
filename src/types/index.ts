export type ConnectionType = "ssh" | "rdp";
export type AuthType = "agent" | "password" | "key";
export type ConnectionStatus = "idle" | "connecting" | "connected" | "error";

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
  created_at: string;
  updated_at: string;
}

export interface Folder {
  id: string;
  name: string;
  parent_id: string | null;
  expanded: boolean;
}

export interface Tab {
  id: string;
  connection_id: string;
  connection_name: string;
  connection_type: ConnectionType;
  status: ConnectionStatus;
  session_id?: string;
}
