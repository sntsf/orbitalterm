# Fedora COPR packaging (the "Fedora PPA")

[COPR](https://copr.fedorainfracloud.org) is Fedora's free build service — the
dnf/rpm equivalent of a Launchpad PPA. It builds the RPM for the Fedora/RHEL
releases you choose and hosts a dnf repo, so users can:

```bash
sudo dnf copr enable sntsx/orbitalterm
sudo dnf install orbitalterm
```

…and get updates with `sudo dnf upgrade`.

`orbitalterm.spec` is the RPM recipe. Unlike the Debian/PPA path, **COPR can
build with network access**, so cargo/npm fetch dependencies during the build —
no vendoring needed.

## One-time setup (web UI — recommended)

1. Sign in to <https://copr.fedorainfracloud.org> with a Fedora account (FAS).
2. **New Project**:
   - Name: `orbitalterm`
   - **Chroots**: tick the current Fedora releases (e.g. `fedora-rawhide`,
     `fedora-44`, `fedora-43`) and, if you want RHEL/Alma/Rocky, `epel-10` /
     `epel-9`. (`x86_64` only is fine.)
   - ⚠️ **Enable "Enable internet access during builds"** (needed for cargo/npm).
3. Open the project → **Packages** → **New package** → method **SCM**:
   - Type: `Git`
   - Clone URL: `https://github.com/sntsf/orbitalterm.git`
   - Committish: a tag (e.g. `v1.0.2`) or `main`
   - Subdirectory: *(leave empty)*
   - Spec File: `packaging/copr/orbitalterm.spec`
   - Build method: `rpkg` (default)
   - Save.
4. **Build** the package (button on the package/project page) and watch the
   build log per chroot.

## Auto-rebuild on new releases

On the package's SCM settings, enable **auto-rebuild** and add the shown
**webhook URL** to the GitHub repo (Settings → Webhooks). COPR will then rebuild
whenever you push. To bump the version, update `Version:` in the spec (and add a
`%changelog` entry) before tagging.

## Optional: trigger from GitHub Actions

Instead of the webhook you can drive COPR from CI with `copr-cli` and a COPR API
token (Settings → API on COPR), e.g. `copr-cli build sntsx/orbitalterm <srpm>`
or `copr-cli buildscm ...`. Ask if you want a `copr.yml` workflow like `ppa.yml`.

## Notes / TODO

- [ ] The `BuildRequires` names target current Fedora; if a build fails on a
      missing package, adjust the name (e.g. winpr headers may come from
      `freerdp-devel` or a separate `winpr-devel`, depending on the release).
- [ ] `webkit2gtk4.1-devel` is the current WebKitGTK devel package on Fedora;
      on very new releases the name may change.
- [ ] Bump `Version:` + `%changelog` per release (or template it with rpkg).
- [ ] Once green, the install line is:
      `sudo dnf copr enable sntsx/orbitalterm && sudo dnf install orbitalterm`
