param(
  [Parameter(Mandatory = $true)][string]$Namespace
)

$ErrorActionPreference = 'Stop'
if ($Namespace -notmatch '^store-[a-z][a-z0-9-]*-[a-f0-9]{8}$') {
  throw "Refusing unexpected namespace name: $Namespace"
}

& kubectl delete namespace $Namespace --wait=true --timeout=5m --ignore-not-found
if ($LASTEXITCODE -ne 0) { throw "Namespace deletion did not finish successfully: $Namespace" }
Write-Host "Deleted namespace $Namespace. PVC reclaim behavior depends on the StorageClass policy."
