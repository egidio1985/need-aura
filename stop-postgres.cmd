@echo off
setlocal

for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":5200" ^| findstr "LISTENING"') do (
  echo Stop servizio PostgreSQL app su porta 5200, processo %%a
  taskkill /PID %%a /F
)

echo Fatto. Puoi riavviare con start-postgres.cmd
pause
