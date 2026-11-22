@echo off
rem Copies oracle-remote-setup.sh to the VM and runs it. Output -> oracle-deploy.log
cd /d "%~dp0"
set KEY=%USERPROFILE%\.ssh\oracle.key
set VM=ubuntu@129.154.239.224
set OPTS=-i "%KEY%" -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30
echo Deploying to Oracle VM. Do not close this window. Log: %~dp0oracle-deploy.log
echo === START %DATE% %TIME% === > oracle-deploy.log
scp %OPTS% oracle-remote-setup.sh %VM%:oracle-remote-setup.sh >> oracle-deploy.log 2>&1
ssh %OPTS% %VM% "bash ~/oracle-remote-setup.sh" >> oracle-deploy.log 2>&1
echo === EXIT %ERRORLEVEL% === >> oracle-deploy.log
echo Finished. You can close this window.
pause
