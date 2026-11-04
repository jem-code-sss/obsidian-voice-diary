$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$workspaceRoot = Split-Path -Parent $projectRoot
$manifest = Get-Content -LiteralPath (Join-Path $projectRoot 'manifest.json') -Raw | ConvertFrom-Json
if ($manifest.id -notmatch '^[a-z0-9-]+$') { throw 'Invalid plugin ID.' }
$bundlePath = Join-Path $projectRoot ('dist/'+$manifest.id)
if (!(Test-Path -LiteralPath (Join-Path $bundlePath 'main.js'))) { throw 'Run npm test or npm run build first.' }
$version = (Get-Content -LiteralPath (Join-Path $projectRoot 'manifest.json') -Raw | ConvertFrom-Json).version
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid release version.' }
$installArchive = Join-Path $workspaceRoot ($manifest.id+"-v$version.zip")
$sourceArchive = Join-Path $workspaceRoot ($manifest.id+"-v$version-source.zip")
$releaseFiles = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'release-files.json') -Raw | ConvertFrom-Json
# Only explicitly reviewed source files enter a fresh source staging directory.
$stagingParent = Join-Path $projectRoot '.release-staging'
New-Item -ItemType Directory -Path $stagingParent -Force | Out-Null
$canonicalProject = (Get-Item -LiteralPath $projectRoot -Force).FullName.TrimEnd('\')
foreach ($path in @($projectRoot,$stagingParent,$bundlePath)) {
    $item = Get-Item -LiteralPath $path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Linked release directory refused.' }
}
$stage = Join-Path $stagingParent ([guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage | Out-Null
foreach ($relative in $releaseFiles.source) {
    if ($relative -match '(^|[/\\])\.\.([/\\]|$)' -or [IO.Path]::IsPathRooted($relative)) { throw 'Invalid source release path.' }
    $source = [IO.Path]::GetFullPath((Join-Path $projectRoot $relative))
    if (!$source.StartsWith($canonicalProject+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Release source escaped project.' }
    $check = $source
    while ($check -and $check -ne $canonicalProject) {
        $item = Get-Item -LiteralPath $check -Force
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Linked source release file refused.' }
        $check = Split-Path -Parent $check
    }
    if (!(Test-Path -LiteralPath $source -PathType Leaf)) { throw "Missing source release file: $relative" }
    $destination = Join-Path $stage $relative
    New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
    Copy-Item -LiteralPath $source -Destination $destination
}
$installParts = @($bundlePath)
foreach ($document in @('README.md','README.zh-CN.md','PRIVACY.md','LICENSE','VALIDATION.md','docs')) {
    $documentPath = Join-Path $projectRoot $document
    if (Test-Path -LiteralPath $documentPath) { $installParts += $documentPath }
}
if (Test-Path -LiteralPath (Join-Path $projectRoot 'install.cmd') -PathType Leaf) { $installParts += Join-Path $projectRoot 'install.cmd' }
Compress-Archive -LiteralPath $installParts -DestinationPath $installArchive -Force
Compress-Archive -LiteralPath @((Get-ChildItem -LiteralPath $stage -Force).FullName) -DestinationPath $sourceArchive -Force
[pscustomobject]@{ version=$version; sourceStage=$stage; installArchive=$installArchive; sourceArchive=$sourceArchive } | ConvertTo-Json -Compress
