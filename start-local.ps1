$ErrorActionPreference = "Stop"
$BundledNode = "C:\Users\cesco\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"

if (Test-Path $BundledNode) {
  & $BundledNode "$PSScriptRoot\server.mjs"
} else {
  node "$PSScriptRoot\server.mjs"
}
