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

Launchpad builders have **no network access**, so everything the build needs
must ship inside the source package. To keep this manageable we **avoid Node on
the builder entirely**:

1. **Frontend** — pre-build `dist/` (with network) and include it. Tauri embeds
   `dist/` at compile time, so the builder never runs Node:
   ```bash
   pnpm install --frozen-lockfile && pnpm build
   ```
2. **Rust crates** — vendor them so `cargo build --offline` works:
   ```bash
   cargo vendor --manifest-path src-tauri/Cargo.toml --locked vendor > .cargo/config.toml
   ```
3. Confirm every `Build-Depends` in `debian/control` exists in the target
   series' archive. **Rust:** Tauri 2 needs `rustc >= 1.77`; if a series ships
   an older toolchain, set your PPA to also depend on a newer Rust PPA
   (PPA settings → *Dependencies*).

## 🤖 Automated path (recommended)

`.github/workflows/ppa.yml` does all of the above on every tag: it pre-builds
`dist/`, vendors the crates, builds a **signed source package per Ubuntu
series**, and `dput`s it to your PPA.

It stays **dormant** until you opt in:

1. Set repository **variable** `ENABLE_PPA = true`.
2. Add repository **secrets**:
   - `PPA_GPG_PRIVATE_KEY` — ASCII-armored private key (registered on Launchpad)
   - `PPA_GPG_PASSPHRASE` — its passphrase
   - `PPA_NAME` — e.g. `your-lp-user/orbitalterm`
   - `PPA_MAINTAINER` — e.g. `OrbitalTerm <anderson.sflorez@gmail.com>`
3. Edit the `series:` matrix in the workflow to the Ubuntu releases you target.

Then a tag push (or **Run workflow**) publishes to the PPA automatically.

## Manual path

Prefer to do it by hand the first time? Follow the steps below.

### One-time setup

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

### Build & upload (per release)

The `debian/` dir must sit at the **root** of the source tree when building.
From a clean checkout of the tag:

```bash
cp -r packaging/ppa/debian ./debian

# Pre-build the frontend and vendor the crates (the offline steps above):
pnpm install --frozen-lockfile && pnpm build
cargo vendor --manifest-path src-tauri/Cargo.toml --locked vendor > .cargo/config.toml

# Update debian/changelog for each series you target (noble, plucky, oracular…).
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

- [ ] Create the Launchpad PPA + GPG key (register the key on Launchpad).
- [ ] Add the secrets + `ENABLE_PPA=true` variable for the automated workflow.
- [ ] Verify build-deps per target series; sort out the Rust toolchain version
      (Tauri 2 needs rustc >= 1.77).
- [ ] Test locally in a clean chroot once (`sbuild` / `pbuilder`) before relying
      on the automated uploads.
