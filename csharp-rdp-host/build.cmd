@echo off
rem ── OrbitalRdpHost build — typed interop (mRemoteNG approach) ──────────────────
rem Generates strongly-typed Interop + AxInterop assemblies from mstscax.dll using
rem aximp.exe (Windows SDK / .NET Framework SDK tool), then compiles against them.
rem This is exactly how mRemoteNG hosts the RDP ActiveX control — no `dynamic`.
setlocal enabledelayedexpansion

rem ── locate csc.exe (.NET Framework 4.x, ships with Windows 11) ─────────────────
set "CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%CSC%" set "CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe"
if not exist "%CSC%" (
  echo ERROR: csc.exe not found. .NET Framework 4.x should ship with Windows 11.
  exit /b 1
)

rem ── locate aximp.exe ──────────────────────────────────────────────────────────
set "AXIMP="
for /f "delims=" %%I in ('where aximp.exe 2^>nul') do set "AXIMP=%%I"
if not defined AXIMP (
  for /d %%D in ("%ProgramFiles(x86)%\Microsoft SDKs\Windows\v*") do (
    for /d %%T in ("%%D\bin\NETFX * Tools") do (
      if exist "%%T\aximp.exe" set "AXIMP=%%T\aximp.exe"
    )
  )
)
if not defined AXIMP (
  for /d %%D in ("%ProgramFiles%\Microsoft SDKs\Windows\v*") do (
    for /d %%T in ("%%D\bin\NETFX * Tools") do (
      if exist "%%T\aximp.exe" set "AXIMP=%%T\aximp.exe"
    )
  )
)
rem ── last-resort: recursive scan of Program Files (slow but thorough) ───────────
if not defined AXIMP (
  echo Searching for aximp.exe under Program Files ^(this can take a minute^)...
  for /f "delims=" %%I in ('where /r "%ProgramFiles(x86)%" aximp.exe 2^>nul') do (
    if not defined AXIMP set "AXIMP=%%I"
  )
)
if not defined AXIMP (
  for /f "delims=" %%I in ('where /r "%ProgramFiles%" aximp.exe 2^>nul') do (
    if not defined AXIMP set "AXIMP=%%I"
  )
)
if not defined AXIMP (
  echo ERROR: aximp.exe not found.
  echo   Install the Windows SDK or .NET Framework Developer Pack, or open a
  echo   "Developer Command Prompt for VS" where aximp.exe is on PATH.
  echo   Typical location:
  echo     C:\Program Files ^(x86^)\Microsoft SDKs\Windows\v10.0A\bin\NETFX 4.8 Tools\aximp.exe
  exit /b 1
)
echo Using aximp: !AXIMP!

rem ── generate typed interop from the system mstscax.dll into .\interop ──────────
if not exist interop mkdir interop
pushd interop
"!AXIMP!" /nologo "%WINDIR%\System32\mstscax.dll"
set "AXRC=!errorlevel!"
popd
if not "!AXRC!"=="0" (
  echo ERROR: aximp failed to generate interop from mstscax.dll
  exit /b 1
)
if not exist "interop\AxMSTSCLib.dll" (
  echo ERROR: AxMSTSCLib.dll was not produced by aximp.
  dir interop
  exit /b 1
)
echo Interop generated:
dir /b interop\*.dll

rem ── compile ───────────────────────────────────────────────────────────────────
echo Using %CSC%
"%CSC%" /nologo /target:exe /platform:x64 /out:OrbitalRdpHost.exe ^
  /r:System.dll /r:System.Core.dll /r:System.Drawing.dll ^
  /r:System.Windows.Forms.dll ^
  /r:interop\MSTSCLib.dll /r:interop\AxMSTSCLib.dll ^
  Program.cs

if errorlevel 1 ( echo BUILD FAILED & exit /b 1 )
echo BUILD OK: %CD%\OrbitalRdpHost.exe
endlocal
