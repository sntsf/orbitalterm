import {
  Database, HardDrive, Globe, Server, Wifi, Cloud, Layers,
  MonitorDot, FolderInput, FolderLock,
} from "lucide-react";
import { TuxIcon, WindowsIcon } from "../components/ConnectionIcons";
import type { ConnectionType } from "../types";

export type ConnIconKey =
  | "linux" | "windows" | "vnc" | "ftp" | "sftp"
  | "database" | "activedir" | "fileserver" | "webserver" | "browser"
  | "server" | "network" | "cloud" | "vm"
  | "azure" | "aws" | "gcp" | "huawei" | "oracle" | "vmware";

interface IconDef {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Icon: React.ComponentType<any>;
  color: string;
  badge?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  badgeIcon?: React.ComponentType<any>;
  label_es: string;
  label_en: string;
}

// Custom VMware-style icon: three stacked wave arcs ≈ VMware logo silhouette
function VmwareIcon({ size = 12, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}
      stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6 Q7.5 2 12 6 Q16.5 10 21 6" />
      <path d="M3 12 Q7.5 8 12 12 Q16.5 16 21 12" />
      <path d="M3 18 Q7.5 14 12 18 Q16.5 22 21 18" />
    </svg>
  );
}

export const CONN_ICONS: Record<ConnIconKey, IconDef> = {
  linux:      { Icon: TuxIcon,      color: "text-yellow-400",  label_es: "Linux",           label_en: "Linux" },
  windows:    { Icon: WindowsIcon,  color: "text-blue-400",    label_es: "Windows",         label_en: "Windows" },
  vnc:        { Icon: MonitorDot,   color: "text-purple-400",  badge: "VNC",  label_es: "VNC",             label_en: "VNC" },
  ftp:        { Icon: FolderInput,  color: "text-orange-400",  badge: "FTP",  label_es: "FTP",             label_en: "FTP" },
  sftp:       { Icon: FolderLock,   color: "text-green-400",   badge: "SFTP", label_es: "SFTP",            label_en: "SFTP" },
  database:   { Icon: Database,     color: "text-cyan-400",    badge: "BD",   label_es: "Base de Datos",   label_en: "Database" },
  activedir:  { Icon: WindowsIcon,  color: "text-blue-400",    badge: "AD",   label_es: "Active Directory",label_en: "Active Directory" },
  fileserver: { Icon: HardDrive,    color: "text-slate-400",   badge: "FS",   label_es: "File Server",     label_en: "File Server" },
  webserver:  { Icon: Server,       color: "text-emerald-400", badgeIcon: Globe, label_es: "Servidor Web", label_en: "Web Server" },
  browser:    { Icon: Globe,        color: "text-sky-400",     label_es: "Navegador",       label_en: "Browser" },
  server:     { Icon: Server,       color: "text-slate-400",   label_es: "Servidor",        label_en: "Server" },
  network:    { Icon: Wifi,         color: "text-teal-400",    label_es: "Red / Switch",    label_en: "Network / Switch" },
  cloud:      { Icon: Cloud,        color: "text-sky-400",     label_es: "Nube",            label_en: "Cloud" },
  vm:         { Icon: Layers,       color: "text-violet-400",  label_es: "Máquina Virtual", label_en: "Virtual Machine" },
  azure:      { Icon: Cloud,        color: "text-blue-400",    badge: "AZ",   label_es: "Azure",           label_en: "Azure" },
  aws:        { Icon: Cloud,        color: "text-orange-400",  badge: "AWS",  label_es: "Amazon AWS",      label_en: "Amazon AWS" },
  gcp:        { Icon: Cloud,        color: "text-red-400",     badge: "GCP",  label_es: "Google Cloud",    label_en: "Google Cloud" },
  huawei:     { Icon: Cloud,        color: "text-rose-500",    badge: "HW",   label_es: "Huawei Cloud",    label_en: "Huawei Cloud" },
  oracle:     { Icon: Cloud,        color: "text-red-600",     badge: "OCI",  label_es: "Oracle Cloud",    label_en: "Oracle Cloud" },
  vmware:     { Icon: VmwareIcon,   color: "text-gray-300",    badge: "VM",   label_es: "VMware",          label_en: "VMware" },
};

export const DEFAULT_CONN_ICON: Record<ConnectionType, ConnIconKey> = {
  ssh:     "linux",
  rdp:     "windows",
  vnc:     "vnc",
  ftp:     "ftp",
  sftp:    "sftp",
  browser: "browser",
};

export function getConnIcon(key: string): IconDef {
  return CONN_ICONS[key as ConnIconKey] ?? CONN_ICONS.server;
}

export function ConnIconDisplay({ iconKey, size = 12 }: { iconKey: string; size?: number }) {
  const { Icon, color, badge, badgeIcon: BadgeIcon } = getConnIcon(iconKey);
  // Badge sits on the bottom half of the icon, overlaid (not below)
  // Font ≈ 55% of icon so it's clearly legible without hiding the whole icon
  const badgeFont = Math.max(7, Math.round(size * 0.55));
  const badgeIconSize = Math.max(6, Math.round(size * 0.5));
  return (
    <span className="relative inline-flex items-center shrink-0" style={{ width: size, height: size }}>
      <Icon size={size} className={color} />
      {badge && (
        <span
          className="absolute font-bold leading-none text-white"
          style={{
            fontSize: badgeFont,
            // Center horizontally, sit on bottom half of the icon
            bottom: 0,
            left: "50%",
            transform: "translateX(-50%)",
            padding: "0 1px",
            borderRadius: 2,
            textShadow: "0 0 2px rgba(0,0,0,0.9), 0 0 4px rgba(0,0,0,0.9)",
            lineHeight: 1,
          }}
        >
          {badge}
        </span>
      )}
      {BadgeIcon && !badge && (
        <span
          className="absolute"
          style={{ bottom: 0, left: "50%", transform: "translateX(-50%)" }}
        >
          <BadgeIcon size={badgeIconSize} className="text-white drop-shadow-[0_0_2px_rgba(0,0,0,0.9)]" />
        </span>
      )}
    </span>
  );
}
