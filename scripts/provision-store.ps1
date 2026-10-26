param(
  [Parameter(Mandatory = $true)][string]$Namespace,
  [Parameter(Mandatory = $true)][string]$Hostname,
  [Parameter(Mandatory = $true)][string]$Title,
  [string]$ValuesFile
)

$ErrorActionPreference = 'Stop'
if ($Namespace -notmatch '^store-[a-z][a-z0-9-]*-[a-f0-9]{8}$') {
  throw "Refusing unexpected namespace name: $Namespace"
}
if ($Hostname -notmatch '^store-[a-z][a-z0-9-]*\.[a-z0-9.-]+$') {
  throw "Refusing unexpected store hostname: $Hostname"
}

$label = & kubectl get namespace $Namespace -o 'jsonpath={.metadata.labels.platform\.example/store}'
if ($LASTEXITCODE -ne 0 -or $label -ne 'true') {
  throw "Namespace is missing platform.example/store=true. Run prepare-store-namespace.ps1 first."
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$chart = Join-Path $repoRoot 'charts/store'
$release = 'shop-' + ($Namespace.Split('-')[-1])
$values = @{
  namespaces = @{ create = $false; store = $Namespace }
  store = @{ host = $Hostname; title = $Title; adminEmail = "admin@$Hostname" }
} | ConvertTo-Json -Depth 5
$tempValues = Join-Path ([System.IO.Path]::GetTempPath()) ("store-values-" + [guid]::NewGuid().ToString('N') + '.json')

try {
  Set-Content -LiteralPath $tempValues -Value $values -Encoding utf8
  $helmArgs = @('upgrade', '--install', $release, $chart, '--namespace', $Namespace)
  if ($ValuesFile) {
    $resolvedValues = if ([System.IO.Path]::IsPathRooted($ValuesFile)) { $ValuesFile } else { Join-Path $repoRoot $ValuesFile }
    if (-not (Test-Path -LiteralPath $resolvedValues -PathType Leaf)) { throw "Values file not found: $resolvedValues" }
    $helmArgs += @('--values', $resolvedValues)
  }
  $helmArgs += @('--values', $tempValues, '--wait', '--wait-for-jobs', '--timeout', '20m')
  & helm @helmArgs
  if ($LASTEXITCODE -ne 0) { throw "Helm install failed for $Namespace (exit $LASTEXITCODE)" }
  Write-Host 'Store workload is ready. Return to Dashboard > Stores and click Register / retry MCP.'
} finally {
  Remove-Item -LiteralPath $tempValues -Force -ErrorAction SilentlyContinue
}
