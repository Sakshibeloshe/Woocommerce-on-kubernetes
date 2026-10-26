param(
  [Parameter(Mandatory = $true)][string]$Namespace
)

$ErrorActionPreference = 'Stop'
if ($Namespace -notmatch '^store-[a-z][a-z0-9-]*-[a-f0-9]{8}$') {
  throw "Refusing unexpected namespace name: $Namespace"
}

$existingNamespaces = & kubectl get namespaces -o name
if ($LASTEXITCODE -ne 0) { throw 'Could not list namespaces. Check your kubectl context and permissions.' }
if ($existingNamespaces -notcontains "namespace/$Namespace") {
  & kubectl create namespace $Namespace
  if ($LASTEXITCODE -ne 0) { throw "Could not create namespace $Namespace" }
} else {
  Write-Host "Namespace $Namespace already exists."
}

& kubectl label namespace $Namespace platform.example/store=true --overwrite
if ($LASTEXITCODE -ne 0) { throw "Could not label namespace $Namespace" }
Write-Host "Prepared $Namespace. Next click Start Helm install and run scripts/provision-store.ps1."
