# Ubuntu PPA (Launchpad) packaging

This folder holds the Debian source packaging used to publish OrbitalTerm to a
**Launchpad PPA**, so Ubuntu users can:

```bash
sudo add-apt-repository ppa:YOUR_LP_USER/orbitalterm
sudo apt update
sudo apt install orbitalterm
```

…and get updates with `sudo apt upgrade`. Launchpad builds **once per Ubuntu
series**, so each build links against that series' own FreeRDP (2 or 3) — the
FreeRDP split is handled for you.

## ⚠️ The hard part: offline builds

Launchpad builders have **no network access**. Everything the build needs must
ship inside the source package:

1. **Rust crates** — vendor them:
   ```bash
   cd src-tauri
   cargo vendor ../vendor
   mkdir -p ../.cargo
   cat >> ../.cargo/config.toml <<'EOF'
   [source.crates-io]
   replace-with = "vendored-sources"
   [source.vendored-sources]
   directory = "vendor"
   EOF
   ```
2. **Node packages** — vendor `node_modules` (or an npm cache) so
   `npm ci --offline` works on the builder. (If you prefer pnpm, vendor its
   store and adjust `debian/rules` accordingly.)
3. Confirm every `Build-Depends` in `debian/control` exists in the target
   series' archive. `rustc/cargo` in older series may be too old; if so, add the
   `ppa:ubuntu-mozilla-security/rust-updates` or a `rustup`-vendored toolchain.

## One-time setup

1. Create a **Launchpad account**: https://launchpad.net
2. Create a **PPA** (e.g. `orbitalterm`).
3. Create an OpenPGP key, upload it to a keyserver and add its fingerprint to
   Launchpad (Launchpad signs and verifies source uploads with it):
   ```bash
   gpg --full-generate-key
   gpg --send-keys --keyserver keyserver.ubuntu.com YOUR_KEY_ID
   ```
4. Install the packaging tools:
   ```bash
   sudo apt install devscripts debhelper dput
   ```

## Build & upload (per release)

The `debian/` dir must sit at the **root** of the source tree when building.
From a clean checkout of the tag:

```bash
cp -r packaging/ppa/debian ./debian
# ... do the vendoring steps above ...

# Update debian/changelog for each series you target (noble, jammy, plucky…).
# The version must end with the series suffix, e.g. 1.0.0-0ppa1~noble1.
dch --create -v 1.0.0-0ppa1~noble1 --distribution noble "Release 1.0.0"

# Build a SIGNED SOURCE package (no binaries — Launchpad builds those):
debuild -S -sa

# Upload to your PPA:
dput ppa:YOUR_LP_USER/orbitalterm ../orbitalterm_1.0.0-0ppa1~noble1_source.changes
```

Repeat the `dch` + `debuild -S` + `dput` cycle for each Ubuntu series (change
`~noble1` → `~jammy1`, `~plucky1`, …). Launchpad emails you build results.

## Files here

| File | Purpose |
|------|---------|
| `debian/control` | Source/binary package metadata and build-deps |
| `debian/rules` | Offline build + install steps |
| `debian/changelog` | Version + target series (update per release) |
| `debian/copyright` | GPL-3.0+ |
| `debian/source/format` | `3.0 (native)` |
| `orbitalterm.desktop` | Desktop launcher installed by `debian/rules` |

## TODO checklist

- [ ] Vendor Rust crates (`vendor/` + `.cargo/config.toml`).
- [ ] Vendor Node packages for an offline `npm ci`.
- [ ] Verify build-deps per target series; sort out the Rust toolchain version.
- [ ] Test locally in a clean chroot: `sbuild` / `pbuilder` for each series.
- [ ] Create the Launchpad PPA + GPG key, then `dput`.
