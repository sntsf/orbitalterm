# OrbitalTerm

**Todas tus conexiones remotas en un mismo espacio de trabajo.**  
**All your remote connections in one workspace.**

OrbitalTerm es un gestor de conexiones remotas de escritorio construido con [Tauri 2](https://tauri.app/) + React. Organiza y gestiona sesiones SSH, RDP, VNC, FTP, SFTP y navegador desde una sola interfaz, con soporte para carpetas, fuentes de datos y búsqueda rápida.

---

## Descargas

Descarga la última versión desde la **[página de Releases](https://github.com/sntsf/orbitalterm/releases/latest)**.

| Sistema | Archivos |
|---------|----------|
| **Windows** | `.exe` (instalador) · `.msi` |
| **Linux** — Ubuntu 25.04+ / Fedora / openSUSE | `.deb` · `.rpm` · `.AppImage` |
| **Linux** — Ubuntu 24.04 y anteriores | `*_ubuntu24.04.deb` · `*.rpm` · `*.AppImage` |

> ¿No sabes cuál elegir en Linux? Mira [Instalación en Linux](#instalación-en-linux) más abajo.

Los instaladores de Windows están firmados digitalmente con un certificado de firma de código **gratuito proporcionado por la [SignPath Foundation](https://signpath.org)** (entidad certificadora: [Certum](https://www.certum.eu)).

---

## Características

- **SSH** — Terminal completa con xterm.js. Autenticación por contraseña o llave SSH.
- **RDP** — Escritorio remoto Windows vía FreeRDP 3 renderizado en panel nativo.
- **VNC** — Visualización de escritorio remoto VNC.
- **FTP** — Explorador de archivos FTP con interfaz de doble panel.
- **SFTP** — Explorador de archivos seguro SFTP con doble panel.
- **Navegador** — Pestaña de navegador embebida. Soporta entradas DNS personalizadas por conexión (sin tocar `/etc/hosts`), ideal para consolas de administración en redes internas (VMware, IPMI, etc.).
- **Multi-pestaña** — Abre varias sesiones en paralelo, cada una como una pestaña independiente.
- **Organización** — Carpetas y fuentes de datos para agrupar conexiones. Arrastra pestañas para reordenarlas.
- **Importación / Exportación** — Soporte para JSON y mRemoteNG.
- **Bilingüe** — Interfaz disponible en Español e Inglés.
- **Datos locales** — Todo se guarda en una base de datos SQLite local. Sin cuentas, sin nube.
- **Temas** — Claro y oscuro.

---

## Capturas de pantalla

> *Próximamente*

---

## Tecnologías

| Capa | Tecnología |
|------|-----------|
| Framework de escritorio | Tauri 2 (Rust) |
| UI | React 18 + TypeScript |
| Estilos | Tailwind CSS 4 |
| Estado | Zustand |
| Terminal | xterm.js |
| Base de datos | SQLite (rusqlite bundled) |
| RDP | FreeRDP 3 |
| SSH | libssh2 |
| FTP/SFTP | suppaftp |

---

## Compilar desde código fuente

### Prerrequisitos

**Rust** (1.77+)
```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

**Node.js** (20+) y pnpm
```bash
npm install -g pnpm
```

**Dependencias del sistema en Ubuntu/Debian**
```bash
sudo apt install \
  libwebkit2gtk-4.1-dev \
  libgtk-3-dev \
  libfreerdp-dev3 \
  libfreerdp-client3-dev \
  libwinpr3-dev \
  pkg-config \
  build-essential
```

### Clonar y ejecutar en modo desarrollo

```bash
git clone https://github.com/sntsf/orbitalterm.git
cd orbitalterm
pnpm install
cargo tauri dev
```

### Generar instaladores

```bash
cargo tauri build
```

Los artefactos se generan en `src-tauri/target/release/bundle/`:

```
src-tauri/target/release/bundle/
├── deb/     OrbitalTerm_0.1.0_amd64.deb
├── rpm/     orbitalterm-0.1.0-1.x86_64.rpm
└── appimage/ OrbitalTerm_0.1.0_amd64.AppImage
```

---

## Instalación en Linux

> **¿Qué archivo descargar?** En cada release hay dos familias de paquetes Linux:
> - **Sin sufijo** (`OrbitalTerm_<v>_amd64.deb`, etc.) → compilados contra **FreeRDP 3**. Para **Ubuntu 25.04 / 26.04** y derivados modernos (usan `libfreerdp3-3` / `libwinpr3-3`).
> - **Con sufijo `_ubuntu24.04`** → compilados contra **FreeRDP 2**. Para **Ubuntu 24.04** y anteriores (usan `libfreerdp2-2` / `libwinpr2-2`).
>
> Instalar el paquete equivocado hará que la app no arranque porque le faltará la versión de FreeRDP correspondiente.

### Opción 1 — AppImage (sin instalar, recomendada)

No requiere instalación ni dependencias adicionales. Funciona en cualquier distribución Linux x86_64.

```bash
chmod +x OrbitalTerm_0.1.0_amd64.AppImage
./OrbitalTerm_0.1.0_amd64.AppImage
```

### Opción 2 — Paquete .deb (Ubuntu / Debian)

> Usa `apt install` (no `dpkg -i`) para que las dependencias se resuelvan automáticamente.

```bash
sudo apt install ./OrbitalTerm_0.1.0_amd64.deb
```

Si usas `dpkg -i` y falla al abrir la aplicación, instala las dependencias manualmente:

```bash
sudo dpkg -i OrbitalTerm_0.1.0_amd64.deb
sudo apt install libfreerdp-client3-3 libfreerdp3-3 libwinpr3-3 libwebkit2gtk-4.1-0
```

Luego verifica que no falte ninguna librería:
```bash
ldd /usr/bin/orbitalterm | grep "not found"
```

### Opción 3 — Paquete .rpm (Fedora / openSUSE)

```bash
sudo rpm -i orbitalterm-0.1.0-1.x86_64.rpm
```

---

## Uso rápido

1. Abre OrbitalTerm.
2. Haz clic en **+** en la barra lateral para crear una nueva conexión.
3. Elige el tipo (SSH, RDP, VNC, FTP, SFTP, Navegador), completa host, usuario y contraseña.
4. Haz doble clic en la conexión para abrirla como una nueva pestaña.

### Conexión tipo Navegador con DNS personalizado

En las propiedades de una conexión Navegador puedes agregar entradas DNS en formato `/etc/hosts` que aplican **únicamente a esa conexión**, sin modificar el sistema:

```
# Mi red interna
192.168.1.1  vcenter.com
192.168.18.1  vcenter.com.pe
```

---

## Licencia

OrbitalTerm es software libre publicado bajo la **GNU General Public License v3.0 o posterior** (GPL-3.0-or-later) — ver [LICENSE](LICENSE).

Esto significa que puedes usar, estudiar, modificar y redistribuir el código libremente, siempre que cualquier versión que distribuyas se mantenga también bajo GPL-3.0 y con el código fuente disponible.

> El nombre **OrbitalTerm** y su logotipo son marcas del proyecto y no se conceden bajo la licencia del código.

Copyright (C) 2026 OrbitalTerm.

This program is free software: you can redistribute it and/or modify it under
the terms of the GNU General Public License as published by the Free Software
Foundation, either version 3 of the License, or (at your option) any later
version. This program is distributed in the hope that it will be useful, but
WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License for more
details.

---

*Desarrollado por OrbitalTerm.*
