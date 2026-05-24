import { create } from "zustand";

export type Lang = "es" | "en";

export const LANGS: { value: Lang; label: string }[] = [
  { value: "es", label: "Español" },
  { value: "en", label: "English" },
];

const T = {
  es: {
    // Menu bar
    menuFile: "Archivo",
    menuView: "Ver",
    menuTools: "Herramientas",
    menuHelp: "Ayuda",
    // File menu
    newConnection: "Nueva Conexión",
    newFolder: "Nueva Carpeta",
    importConnections: "Importar conexiones…",
    exportConnections: "Exportar conexiones…",
    exit: "Salir",
    // View menu
    fullscreen: "Pantalla Completa",
    showHideSidebar: "Mostrar/Ocultar Sidebar",
    // Tools menu
    language: "Idioma",
    theme: "Tema",
    termFontSize: "Tamaño de fuente (terminal)",
    resetLayout: "Restablecer disposición",
    // Help menu
    about: "Acerca de OrbitalTerm",
    website: "Sitio Web",
    donate: "Donar",
    checkUpdates: "Comprobar Actualizaciones",
    reportBug: "Reportar un error",
    // About dialog
    aboutDesc: "Gestor ligero de conexiones remotas para administradores de sistemas.",
    version: "Versión",
    close: "Cerrar",
    developer: "Desarrollado por OrbitalTerm",
    // Messages
    importedOk: "conexión(es) importada(s).",
    exportedOk: "Archivo exportado correctamente.",
    checkUpdatesMsg: "Revisando la última versión en GitHub…",
    // Sidebar / UI
    connections: "Conexiones",
    searchPlaceholder: "Buscar por nombre o IP…",
    noResults: "Sin resultados",
    results: "resultado(s)",
    navHint: "↑↓ navegar · Enter abrir",
    noConnectionsYet: "Sin conexiones aún.",
    addFirst: "Agrega la primera",
    newConnectionMenu: "Nueva Conexión",
    newSubfolder: "Nueva Subcarpeta",
    rename: "Renombrar",
    delete: "Eliminar",
    connect: "Conectar",
    duplicate: "Duplicar",
    // Properties panel
    propNewConnection: "Nueva Conexión",
    propProperties: "Propiedades",
    propConnect: "Conectar",
    propSave: "Guardar",
    propSaving: "Guardando…",
    propRequired: "Nombre, host y usuario son obligatorios.",
    propType: "Tipo",
    propName: "Nombre",
    propDesc: "Descripción",
    propHost: "Host / IP",
    propPort: "Puerto",
    propUser: "Usuario",
    propAuth: "Autent.",
    propSshKey: "Llave SSH",
    propPassword: "Contraseña",
    propPasswordSaved: "●●●●●● (guardada)",
    propPasswordPlaceholder: "Ingresar contraseña",
    propDomain: "Dominio",
    propNotes: "Notas",
    propSelectOrCreate: "Selecciona una conexión o haz clic en + para crear una",
    // Welcome
    welcomeSubtitle: "Gestor ligero de conexiones remotas para administradores de sistemas",
    welcomeNewSsh: "Nueva SSH",
    welcomeNewSshDesc: "Conectarse a un servidor Linux / Unix",
    welcomeNewRdp: "Nueva RDP",
    welcomeNewRdpDesc: "Conectarse a un servidor Windows",
    welcomeImport: "Importar",
    welcomeImportDesc: "Importar desde JSON o mRemoteNG",
    welcomeHint: "Doble clic en una conexión para abrir una pestaña. Todos los datos se guardan localmente.",
  },
  en: {
    menuFile: "File",
    menuView: "View",
    menuTools: "Tools",
    menuHelp: "Help",
    newConnection: "New Connection",
    newFolder: "New Folder",
    importConnections: "Import connections…",
    exportConnections: "Export connections…",
    exit: "Exit",
    fullscreen: "Fullscreen",
    showHideSidebar: "Show/Hide Sidebar",
    language: "Language",
    theme: "Theme",
    termFontSize: "Terminal font size",
    resetLayout: "Reset layout",
    about: "About OrbitalTerm",
    website: "Website",
    donate: "Donate",
    checkUpdates: "Check for Updates",
    reportBug: "Report a bug",
    aboutDesc: "Lightweight remote connection manager for sysadmins.",
    version: "Version",
    close: "Close",
    developer: "Developed by OrbitalTerm",
    importedOk: "connection(s) imported.",
    exportedOk: "File exported successfully.",
    checkUpdatesMsg: "Checking for the latest version on GitHub…",
    connections: "Connections",
    searchPlaceholder: "Search by name or IP…",
    noResults: "No results",
    results: "result(s)",
    navHint: "↑↓ navigate · Enter open",
    noConnectionsYet: "No connections yet.",
    addFirst: "Add the first one",
    newConnectionMenu: "New Connection",
    newSubfolder: "New Subfolder",
    rename: "Rename",
    delete: "Delete",
    connect: "Connect",
    duplicate: "Duplicate",
    propNewConnection: "New Connection",
    propProperties: "Properties",
    propConnect: "Connect",
    propSave: "Save",
    propSaving: "Saving…",
    propRequired: "Name, host and username are required.",
    propType: "Type",
    propName: "Name",
    propDesc: "Description",
    propHost: "Host / IP",
    propPort: "Port",
    propUser: "Username",
    propAuth: "Auth",
    propSshKey: "SSH Key",
    propPassword: "Password",
    propPasswordSaved: "●●●●●● (saved)",
    propPasswordPlaceholder: "Enter password",
    propDomain: "Domain",
    propNotes: "Notes",
    propSelectOrCreate: "Select a connection or click + to create one",
    welcomeSubtitle: "Lightweight remote connection manager for sysadmins",
    welcomeNewSsh: "New SSH",
    welcomeNewSshDesc: "Connect to a Linux / Unix server",
    welcomeNewRdp: "New RDP",
    welcomeNewRdpDesc: "Connect to a Windows server",
    welcomeImport: "Import",
    welcomeImportDesc: "Import from JSON or mRemoteNG",
    welcomeHint: "Double-click any connection to open a session tab. All data is stored locally.",
  },
} as const;

export type TranslationKey = keyof typeof T.es;

interface I18nStore {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (k: TranslationKey) => string;
}

export const useI18nStore = create<I18nStore>((set, get) => ({
  lang: (localStorage.getItem("orbitalterm:lang") as Lang | null) ?? "es",
  setLang: (lang) => {
    localStorage.setItem("orbitalterm:lang", lang);
    set({ lang });
  },
  t: (k) => T[get().lang][k] as string,
}));

export function useT() {
  // Destructure lang so this hook re-renders when lang changes
  const { lang, t } = useI18nStore();
  void lang;
  return t;
}
