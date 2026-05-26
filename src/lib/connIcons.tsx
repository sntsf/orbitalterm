import {
  Database, HardDrive, Globe, Shield, Server, Wifi, Cloud, Cpu,
  MonitorDot, FolderInput, FolderLock,
} from "lucide-react";
import { TuxIcon, WindowsIcon } from "../components/ConnectionIcons";
import type { ConnectionType } from "../types";

export type ConnIconKey =
  | "linux" | "windows" | "vnc" | "ftp" | "sftp"
  | "database" | "activedir" | "fileserver" | "webserver"
  | "server" | "network" | "cloud" | "vm"
  | "azure" | "aws" | "gcp" | "huawei" | "oracle" | "vmware";

interface IconDef {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Icon: React.ComponentType<any>;
  color: string;
  badge?: string;
  label_es: string;
  label_en: string;
}

export const CONN_ICONS: Record<ConnIconKey, IconDef> = {
  linux:      { Icon: TuxIcon,      color: "text-yellow-400",  label_es: "Linux",           label_en: "Linux" },
  windows:    { Icon: WindowsIcon,  color: "text-blue-400",    label_es: "Windows",         label_en: "Windows" },
  vnc:        { Icon: MonitorDot,   color: "text-purple-400",  badge: "VNC", label_es: "VNC",             label_en: "VNC" },
  ftp:        { Icon: FolderInput,  color: "text-orange-400",  label_es: "FTP",             label_en: "FTP" },
  sftp:       { Icon: FolderLock,   color: "text-green-400",   label_es: "SFTP",            label_en: "SFTP" },
  database:   { Icon: Database,     color: "text-cyan-400",    badge: "BD",  label_es: "Base de Datos",   label_en: "Database" },
  activedir:  { Icon: Shield,       color: "text-blue-500",    badge: "AD",  label_es: "Active Directory",label_en: "Active Directory" },
  fileserver: { Icon: HardDrive,    color: "text-slate-400",   label_es: "File Server",     label_en: "File Server" },
  webserver:  { Icon: Globe,        color: "text-emerald-400", label_es: "Servidor Web",    label_en: "Web Server" },
  server:     { Icon: Server,       color: "text-slate-400",   label_es: "Servidor",        label_en: "Server" },
  network:    { Icon: Wifi,         color: "text-teal-400",    label_es: "Red / Switch",    label_en: "Network / Switch" },
  cloud:      { Icon: Cloud,        color: "text-sky-400",     label_es: "Nube",            label_en: "Cloud" },
  vm:         { Icon: Cpu,          color: "text-violet-400",  label_es: "Máquina Virtual", label_en: "Virtual Machine" },
  azure:      { Icon: Cloud,        color: "text-blue-400",    badge: "AZ",  label_es: "Azure",           label_en: "Azure" },
  aws:        { Icon: Cloud,        color: "text-orange-400",  badge: "AWS", label_es: "Amazon AWS",      label_en: "Amazon AWS" },
  gcp:        { Icon: Cloud,        color: "text-red-400",     badge: "GCP", label_es: "Google Cloud",    label_en: "Google Cloud" },
  huawei:     { Icon: Cloud,        color: "text-rose-500",    badge: "HW",  label_es: "Huawei Cloud",    label_en: "Huawei Cloud" },
  oracle:     { Icon: Cloud,        color: "text-red-600",     badge: "OCI", label_es: "Oracle Cloud",    label_en: "Oracle Cloud" },
  vmware:     { Icon: Cpu,          color: "text-gray-400",    badge: "VM",  label_es: "VMware",          label_en: "VMware" },
};

export const DEFAULT_CONN_ICON: Record<ConnectionType, ConnIconKey> = {
  ssh:  "linux",
  rdp:  "windows",
  vnc:  "vnc",
  ftp:  "ftp",
  sftp: "sftp",
};

export function getConnIcon(key: string): IconDef {
  return CONN_ICONS[key as ConnIconKey] ?? CONN_ICONS.server;
}

export function ConnIconDisplay({ iconKey, size = 12 }: { iconKey: string; size?: number }) {
  const { Icon, color, badge } = getConnIcon(iconKey);
  return (
    <span className="relative inline-flex items-center shrink-0" style={{ width: size, height: size }}>
      <Icon size={size} className={color} />
      {badge && (
        <span
          className="absolute font-bold leading-none text-[var(--color-text-muted)] bg-[var(--color-bg-sidebar)]"
          style={{
            fontSize: Math.max(5, Math.floor(size * 0.45)),
            bottom: -3,
            right: -4,
            padding: "0 1px",
            borderRadius: 2,
          }}
        >
          {badge}
        </span>
      )}
    </span>
  );
}
