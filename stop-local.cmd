@echo off
setlocal

for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":5173" ^| findstr "LISTENING"') do (
  echo Stop servizio locale su porta 5173, processo %%a
  taskkill /PID %%a /F
)

echo Fatto. Puoi riavviare con start-local.cmd
pause
