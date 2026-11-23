@echo off
rem Operator step for the Stores page, run ON the Oracle VM (not your local cluster).
rem Copy the namespace / hostname / title from the store card in the dashboard. Log: oracle-store.log
cd /d "%~dp0"
set KEY=%USERPROFILE%\.ssh\oracle.key
set VM=ubuntu@129.154.239.224
set OPTS=-i "%KEY%" -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30
echo 1 = create store (prepare namespace + Helm install)
echo 2 = delete store namespace
set /p MODE=Choose 1 or 2: 
set /p NS=Namespace (e.g. store-blue-shop-1234abcd): 
if "%MODE%"=="2" goto delete
set /p HOST=Hostname (e.g. store-blue-shop.129.154.239.224.nip.io): 
set /p TITLE=Store title: 
set "TITLE=%TITLE:'=%"
set "TITLE=%TITLE:"=%"
echo.
echo Creating %NS% on the VM (5-15 min). Do not close this window. Log: %~dp0oracle-store.log
ssh %OPTS% %VM% "export KUBECONFIG=~/.kube/config; cd ~/Woocommerce-on-kubernetes && git pull --ff-only -q; bash scripts/prepare-store-namespace.sh '%NS%' && STORE_VALUES_FILE=charts/platform/values-oracle.yaml bash scripts/provision-store.sh '%NS%' '%HOST%' '%TITLE%' && kubectl -n '%NS%' get pods" > oracle-store.log 2>&1
if errorlevel 1 (echo FAILED - see oracle-store.log & pause & exit /b 1)
echo Done. In the dashboard: Stores - click "Start Helm install" if not done, then "Register / retry MCP".
pause
exit /b 0
:delete
echo Deleting %NS% on the VM (removes its database, volumes, Secrets). Log: %~dp0oracle-store.log
ssh %OPTS% %VM% "export KUBECONFIG=~/.kube/config; cd ~/Woocommerce-on-kubernetes && bash scripts/delete-store-namespace.sh '%NS%'" > oracle-store.log 2>&1
if errorlevel 1 (echo FAILED - see oracle-store.log & pause & exit /b 1)
echo Done. In the dashboard click "Confirm namespace deleted".
pause
