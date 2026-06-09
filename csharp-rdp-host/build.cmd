@echo off
rem ── OrbitalRdpHost build (zero install) ───────────────────────────────────────
rem Compiles with the C# compiler that ships with .NET Framework 4.x, which is
rem present on every Windows 11 machine. No .NET SDK or Visual Studio required.
setlocal

set "CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%CSC%" set "CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe"
if not exist "%CSC%" (
  echo ERROR: csc.exe not found. .NET Framework 4.x should ship with Windows 11.
  exit /b 1
)

echo Using %CSC%
"%CSC%" /nologo /target:exe /platform:x64 /out:OrbitalRdpHost.exe ^
  /r:System.dll /r:System.Core.dll /r:System.Drawing.dll ^
  /r:System.Windows.Forms.dll /r:Microsoft.CSharp.dll ^
  Program.cs

if errorlevel 1 ( echo BUILD FAILED & exit /b 1 )
echo BUILD OK: %CD%\OrbitalRdpHost.exe
endlocal
