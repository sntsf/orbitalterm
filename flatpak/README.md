# Flatpak / Flathub packaging

This folder contains the Flatpak manifest and metadata to publish OrbitalTerm
on [Flathub](https://flathub.org). Flatpak gives Linux users a single,
cross-distro install command with automatic updates, and it **bundles its own
FreeRDP**, so the FreeRDP 2 vs 3 split disappears.

```
flatpak install flathub com.orbitalterm.OrbitalTerm
```

## Files

| File | Purpose |
|------|---------|
| `com.orbitalterm.OrbitalTerm.yml` | The Flatpak build manifest |
| `com.orbitalterm.OrbitalTerm.desktop` | Desktop launcher entry |
| `com.orbitalterm.OrbitalTerm.metainfo.xml` | AppStream metadata (required by Flathub) |

## ⚠️ Before it builds: generate the offline dependency sources

Flathub builds **without network access**, so every dependency must be declared
as a source. Generate the two manifests on a machine with the tools installed:

### 1. Rust crates

```bash
pip install aiohttp toml          # deps of the generator
curl -O https://raw.githubusercontent.com/flatpak/flatpak-builder-tools/master/cargo/flatpak-cargo-generator.py
python3 flatpak-cargo-generator.py ../src-tauri/Cargo.lock -o cargo-sources.json
```

### 2. Node / pnpm packages

```bash
npm install -g flatpak-node-generator   # or use the script from flatpak-builder-tools/node
flatpak-node-generator pnpm ../pnpm-lock.yaml -o node-sources.json
```

Both files are already referenced in the manifest's `sources:` list. They are
**git-ignored** (large, regenerated each build), so they must exist before you
build locally — or just let CI generate them (below).

## 🤖 Automated path (recommended)

`.github/workflows/flatpak.yml` generates both source files and builds the
bundle with `flatpak-builder` on every tag, uploading `orbitalterm.flatpak` as
an artifact. It stays **dormant** until you set repository variable
`ENABLE_FLATPAK = true`.

Use it to validate the build in CI; the actual Flathub listing is still done via
a PR to `flathub/flathub` (see below).

## Build & test locally

```bash
flatpak install flathub org.gnome.Platform//47 org.gnome.Sdk//47 \
  org.freedesktop.Sdk.Extension.rust-stable//24.08 \
  org.freedesktop.Sdk.Extension.node20//24.08

flatpak-builder --user --install --force-clean build-dir \
  com.orbitalterm.OrbitalTerm.yml

flatpak run com.orbitalterm.OrbitalTerm
```

Validate the metadata before submitting:

```bash
flatpak run org.freedesktop.appstream-glib validate com.orbitalterm.OrbitalTerm.metainfo.xml
desktop-file-validate com.orbitalterm.OrbitalTerm.desktop
```

## Submit to Flathub

1. Fork https://github.com/flathub/flathub and create a branch
   `new-pr/com.orbitalterm.OrbitalTerm`.
2. Add this manifest + metadata to a folder named `com.orbitalterm.OrbitalTerm`.
3. Open a pull request against `flathub/flathub`. The Flathub bots build and
   review it; iterate until the build is green and the reviewer approves.
4. Because the app id is `com.orbitalterm.OrbitalTerm`, Flathub will ask you to
   prove ownership of `orbitalterm.com` (a DNS TXT record or a file under
   `/.well-known/`).

## TODO checklist

- [ ] Generate `cargo-sources.json` and `node-sources.json` and reference them.
- [ ] Pin the FreeRDP tag to the version you build against; add any missing
      sub-modules surfaced by a local build.
- [ ] Add real screenshots over HTTPS to the metainfo.
- [ ] Bump the `tag:` and `<release>` on every version.
- [ ] Verify the app id / domain ownership for Flathub.
