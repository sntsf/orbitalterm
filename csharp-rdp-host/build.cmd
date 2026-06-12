@echo off
:: Build OrbitalRdpHost.exe using the .NET Framework C# compiler (no SDK needed)
::
:: Searches for csc.exe in common .NET Framework locations.
:: Output: OrbitalRdpHost.exe in this directory.

setlocal enabledelayedexpansion

set "CSC="
for %%d in (
    "%WINDIR%\Microsoft.NET\Framework64\v4.0.30319"
    "%WINDIR%\Microsoft.NET\Framework\v4.0.30319"
    "%WINDIR%\Microsoft.NET\Framework64\v3.5"
    "%WINDIR%\Microsoft.NET\Framework\v3.5"
) do (
    if exist "%%~d\csc.exe" (
        set "CSC=%%~d\csc.exe"
        goto :found
    )
)

echo ERROR: csc.exe not found. .NET Framework 4.x must be installed.
exit /b 1

:found
echo Using compiler: %CSC%

"%CSC%" ^
    /nologo ^
    /target:exe ^
    /platform:x64 ^
    /optimize+ ^
    /out:OrbitalRdpHost.exe ^
    /r:System.dll ^
    /r:System.Core.dll ^
    /r:System.Drawing.dll ^
    /r:System.Windows.Forms.dll ^
    /r:Microsoft.CSharp.dll ^
    Program.cs

if %ERRORLEVEL% neq 0 (
    echo BUILD FAILED
    exit /b %ERRORLEVEL%
)

echo BUILD OK: OrbitalRdpHost.exe
