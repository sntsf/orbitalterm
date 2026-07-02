# RPM spec for OrbitalTerm — built on Fedora COPR (the "Fedora PPA").
#
# COPR builds in a mock chroot. Enable "Enable internet access during builds"
# in the COPR project settings so cargo/npm can fetch dependencies (this avoids
# the vendoring the Debian/PPA build needs). See packaging/copr/README.md.

Name:           orbitalterm
Version:        1.0.2
Release:        1%{?dist}
Summary:        Remote connection manager (SSH, RDP, VNC, FTP, SFTP)

License:        GPL-3.0-or-later
URL:            https://orbitalterm.com
Source0:        https://github.com/sntsf/orbitalterm/archive/refs/tags/v%{version}.tar.gz#/%{name}-%{version}.tar.gz

# Build toolchain (needs network enabled in the COPR project for cargo/npm).
BuildRequires:  cargo
BuildRequires:  rust
BuildRequires:  nodejs
BuildRequires:  npm
BuildRequires:  gcc
BuildRequires:  pkgconfig
BuildRequires:  openssl-devel
BuildRequires:  gtk3-devel
BuildRequires:  webkit2gtk4.1-devel
BuildRequires:  freerdp-devel
BuildRequires:  librsvg2-devel
BuildRequires:  desktop-file-utils

Requires:       webkit2gtk4.1
Requires:       gtk3
Requires:       freerdp-libs

%description
OrbitalTerm is a desktop remote-connection manager. Organize and open SSH,
RDP, VNC, FTP, SFTP and embedded-browser sessions from a single tabbed
workspace, with folders, data sources and quick search. Saved passwords are
encrypted at rest (AES-256-GCM) and all data is stored locally — no accounts,
no cloud.

%prep
%autosetup -n %{name}-%{version}

%build
# Frontend (Tauri embeds dist/ into the binary at compile time).
npm install -g pnpm
pnpm install --frozen-lockfile
pnpm build
# Rust / Tauri binary.
cd src-tauri
cargo build --release --locked
cd ..

%install
install -Dm0755 src-tauri/target/release/orbitalterm %{buildroot}%{_bindir}/%{name}
install -Dm0644 packaging/ppa/orbitalterm.desktop %{buildroot}%{_datadir}/applications/%{name}.desktop
install -Dm0644 src-tauri/icons/128x128.png %{buildroot}%{_datadir}/icons/hicolor/128x128/apps/%{name}.png
install -Dm0644 src-tauri/icons/icon.png %{buildroot}%{_datadir}/icons/hicolor/512x512/apps/%{name}.png
desktop-file-validate %{buildroot}%{_datadir}/applications/%{name}.desktop

%files
%license LICENSE
%doc README.md
%{_bindir}/%{name}
%{_datadir}/applications/%{name}.desktop
%{_datadir}/icons/hicolor/128x128/apps/%{name}.png
%{_datadir}/icons/hicolor/512x512/apps/%{name}.png

%changelog
* Thu Jul 02 2026 OrbitalTerm <anderson.sflorez@gmail.com> - 1.0.2-1
- Initial COPR package.
