# OrbitalRdpHost — C# RDP ActiveX helper

A small standalone WinForms helper that hosts the Microsoft RDP ActiveX control
(`MsRdpClient10`/`9`) and logs in **silently** (no credential dialog) by feeding
the password through the control's `ClearTextPassword` interfaces under a proper
WinForms `AxHost` OLE site.

This is the piece OrbitalTerm spawns and reparents (`SetParent`) into its RDP
host window. Right now it's standalone so we can prove silent login in isolation
before wiring it into the Rust/Tauri app.

## Why C# instead of in-process Rust COM

Hosting `mstscax` directly from Rust required hand-building the entire OLE site
and **still** could not suppress the NLA credential prompt on modern Windows:
`ClearTextPassword` was ignored, `IMsTscNonScriptable` QI failed, and
`PromptForCredentials` returned `E_NOTIMPL`. WinForms `AxHost` gives the control
the correct OLE in-place site and message pump that production RDP apps rely on,
which is what makes `ClearTextPassword` actually feed CredSSP/NLA.

## Build

Requires the **.NET 8 SDK** (`dotnet --version` should print 8.x).

```powershell
cd csharp-rdp-host
dotnet build -c Release
```

Output: `bin/Release/net8.0-windows/OrbitalRdpHost.exe`

> No .NET 8 SDK? Change `<TargetFramework>` in `OrbitalRdpHost.csproj` to `net48`
> and build from a Developer Command Prompt with `msbuild -p:Configuration=Release`.

## Test (standalone — opens its own window)

```powershell
cd bin/Release/net8.0-windows
./OrbitalRdpHost.exe --server 10.240.0.10 --user "gmdsa\canv_asantos" --password "Hola1234**"
```

### What success looks like

A window opens and connects to the desktop **without ever asking for a
password**. On stdout you should see:

```
INFO:clsid=C0EFA91A-EEB7-41C7-97FA-F0ED645EFB24
STATE:connecting
STATE:connected
```

If instead you get `STATE:disconnected reason=<n>` or a credential prompt still
appears, copy the full stdout (including any `WARN:`/`ERROR:` lines) — that tells
us exactly which password path the control accepted or rejected.

## Embedded mode (used later by OrbitalTerm)

```powershell
echo Hola1234** | ./OrbitalRdpHost.exe --parent <HWND> --server 10.240.0.10 --user "gmdsa\canv_asantos" --port 3389
```

`--parent` is the decimal HWND of the host window to embed into; the password is
read from stdin so it never appears on the command line.
