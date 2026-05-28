@echo off
setlocal
set "APP_DIR=%~dp0"
set "BUNDLED_NODE=C:\Users\cesco\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"

cd /d "%APP_DIR%"

if exist "%BUNDLED_NODE%" (
  "%BUNDLED_NODE%" server.mjs
) else (
  node server.mjs
)

pause
