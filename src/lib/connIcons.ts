import {
  Terminal, Monitor, Database, HardDrive, Globe,
  Shield, Server, Wifi, Cloud, Cpu,
} from "lucide-react";
import type { ConnectionType } from "../types";

export const CONN_ICONS = {
  linux:      { label_es: "Linux / Unix",           label_en: "Linux / Unix",         color: "text-orange-400",  Icon: Terminal  },
  windows:    { label_es: "Windows",                label_en: "Windows",               color: "text-sky-400",     Icon: Monitor   },
  database:   { label_es: "Base de datos",          label_en: "Database",              color: "text-purple-400",  Icon: Database  },
  fileserver: { label_es: "Servidor de archivos",   label_en: "File Server",           color: "text-amber-400",   Icon: HardDrive },
  webserver:  { label_es: "Servidor web",           label_en: "Web Server",            color: "text-green-400",   Icon: Globe     },
  activedir:  { label_es: "Active Directory",       label_en: "Active Directory",      color: "text-blue-400",    Icon: Shield    },
  server:     { label_es: "Servidor genérico",      label_en: "Generic Server",        color: "text-slate-400",   Icon: Server    },
  network:    { label_es: "Red / Router",           label_en: "Network / Router",      color: "text-cyan-400",    Icon: Wifi      },
  cloud:      { label_es: "Nube / Cloud",           label_en: "Cloud",                 color: "text-sky-300",     Icon: Cloud     },
  vm:         { label_es: "Máquina virtual",        label_en: "Virtual Machine",       color: "text-violet-400",  Icon: Cpu       },
} as const;

export type ConnIconKey = keyof typeof CONN_ICONS;

export const DEFAULT_CONN_ICON: Record<ConnectionType, ConnIconKey> = {
  ssh:  "linux",
  rdp:  "windows",
  vnc:  "windows",
  ftp:  "fileserver",
  sftp: "fileserver",
};

export function getConnIcon(key: string) {
  return CONN_ICONS[key as ConnIconKey] ?? CONN_ICONS.server;
}
