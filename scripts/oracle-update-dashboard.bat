@echo off
rem Rebuilds the dashboard image for ARM, pushes it to GHCR, and rolls it out on the Oracle VM.
rem Needs: Docker Desktop running + "docker login ghcr.io" done once. Output -> oracle-update.log
cd /d "%~dp0"
set TAG=0.2.0
set IMG=ghcr.io/sakshibeloshe/mcp-dashboard:%TAG%
set KEY=%USERPROFILE%\.ssh\oracle.key
set VM=ubuntu@129.154.239.224
set OPTS=-i "%KEY%" -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30
echo Building and deploying dashboard %TAG%. Do not close this window. Log: %~dp0oracle-update.log
echo === START %DATE% %TIME% === > oracle-update.log
echo --- build + push %IMG% >> oracle-update.log
docker buildx build --platform linux/arm64 -t %IMG% ..\dashboard --push >> oracle-update.log 2>&1
if errorlevel 1 (echo === BUILD FAILED === >> oracle-update.log & echo Build failed, see log. & pause & exit /b 1)
echo --- helm upgrade on VM >> oracle-update.log
ssh %OPTS% %VM% "export KUBECONFIG=~/.kube/config; cd ~/Woocommerce-on-kubernetes && helm upgrade platform charts/platform -f charts/platform/values-oracle.yaml --set dashboard.image.tag=%TAG% --timeout 10m --wait && kubectl -n gateway get pods -l app=dashboard -o wide && kubectl -n gateway get deploy dashboard -o jsonpath='{.spec.template.spec.containers[0].image}'; echo" >> oracle-update.log 2>&1
echo === EXIT %ERRORLEVEL% === >> oracle-update.log
echo Finished. You can close this window.
pause
