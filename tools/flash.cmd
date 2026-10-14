@echo off
rem Runs flash.ps1 without changing the PowerShell execution policy. See docs\FLASHING.md.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0flash.ps1" %*
exit /b %ERRORLEVEL%
