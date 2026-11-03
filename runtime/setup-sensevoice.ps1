# Explicit, per-user Windows x64 setup. No recordings or API keys are read.
[CmdletBinding()]
param([string]$Root = (Join-Path $env:LOCALAPPDATA 'voice-diary-unified\sensevoice'))

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version Latest
$script:Phase = 'root'
$script:Lock = $null
$script:Temporary = $null
$script:SetupRoot = $null
$script:PythonInstallerUrl = 'https://www.python.org/ftp/python/3.12.10/python-3.12.10-amd64.exe'

function Write-SetupEvent {
    param([string]$Event, [string]$Stage = '', [int]$Pct = -1, [string]$Code = '')
    $item = [ordered]@{ event = $Event }
    if ($Stage) { $item.stage = $Stage }
    if ($Pct -ge 0) { $item.pct = [Math]::Min(100, $Pct) }
    if ($Code) { $item.code = $Code }
    [Console]::Out.WriteLine(($item | ConvertTo-Json -Compress))
}

function Assert-NoReparse {
    param([string]$Path)
    $itemPath = [IO.Path]::GetFullPath($Path)
    while ($itemPath) {
        if (Test-Path -LiteralPath $itemPath) {
            $item = Get-Item -LiteralPath $itemPath -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Linked paths are unsupported' }
        }
        $parent = [IO.Path]::GetDirectoryName($itemPath)
        if ($parent -eq $itemPath) { break }
        $itemPath = $parent
    }
}

function Quote-ProcessArgument {
    param([string]$Value)
    # ProcessStartInfo.Arguments uses Windows command-line quoting, not shell quoting.
    return '"' + ([regex]::Replace([regex]::Replace($Value, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1')) + '"'
}

function Stop-OwnedProcess {
    param([Diagnostics.Process]$Process)
    if (-not $Process.HasExited) {
        $kill = New-Object Diagnostics.ProcessStartInfo
        $kill.FileName = Join-Path $env:SystemRoot 'System32\taskkill.exe'
        $kill.Arguments = '/PID ' + $Process.Id + ' /T /F'
        $kill.UseShellExecute = $false
        $kill.CreateNoWindow = $true
        $kill.RedirectStandardOutput = $true
        $kill.RedirectStandardError = $true
        $killer = [Diagnostics.Process]::Start($kill)
        try {
            $discardOut = $killer.StandardOutput.ReadToEndAsync()
            $discardError = $killer.StandardError.ReadToEndAsync()
            [void]$killer.WaitForExit(10000)
        } finally { $killer.Dispose() }
        if (-not $Process.HasExited) { $Process.Kill() }
    }
}

function Invoke-SetupProcess {
    param([string]$File, [string[]]$Arguments, [int]$TimeoutSeconds = 900, [switch]$Protocol)
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = $File
    $info.Arguments = (($Arguments | ForEach-Object { Quote-ProcessArgument $_ }) -join ' ')
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.StandardOutputEncoding = New-Object Text.UTF8Encoding($false)
    $info.StandardErrorEncoding = New-Object Text.UTF8Encoding($false)
    $info.WorkingDirectory = $script:SetupRoot
    $info.EnvironmentVariables['PYTHONUTF8'] = '1'
    $info.EnvironmentVariables['PYTHONDONTWRITEBYTECODE'] = '1'
    $process = [Diagnostics.Process]::Start($info)
    $text = New-Object Text.StringBuilder
    $errorCode = ''
    $clock = [Diagnostics.Stopwatch]::StartNew()
    try {
        # Drain both pipes; never expose pip/native diagnostics or private paths.
        $errorTask = $process.StandardError.ReadToEndAsync()
        $lineTask = $process.StandardOutput.ReadLineAsync()
        while ($true) {
            if ($clock.Elapsed.TotalSeconds -gt $TimeoutSeconds) { throw 'Setup process timed out' }
            if (-not $lineTask.Wait(100)) { continue }
            $line = $lineTask.Result
            if ($null -eq $line) { break }
            if ($text.Length -lt 32768) {
                [void]$text.AppendLine($line.Substring(0, [Math]::Min($line.Length, 32768 - $text.Length)))
            }
            if ($Protocol) {
                try {
                    $value = $line | ConvertFrom-Json -ErrorAction Stop
                    if ($value.event -eq 'progress' -and $value.stage -in @('python', 'dependencies', 'model', 'verify')) {
                        $pct = -1
                        if ($value.PSObject.Properties.Name -contains 'pct' -and $value.pct -is [ValueType]) {
                            $pct = [Math]::Max(-1, [Math]::Min(100, [int]$value.pct))
                        }
                        Write-SetupEvent -Event 'progress' -Stage $value.stage -Pct $pct
                    } elseif ($value.event -eq 'error' -and $value.code -in @('root', 'download', 'model', 'runtime')) {
                        $errorCode = [string]$value.code
                    }
                } catch { } # Non-protocol output stays private.
            }
            $lineTask = $process.StandardOutput.ReadLineAsync()
        }
        $remaining = [Math]::Max(1, [int](($TimeoutSeconds - $clock.Elapsed.TotalSeconds) * 1000))
        if (-not $process.WaitForExit($remaining)) { throw 'Setup process timed out' }
        return [pscustomobject]@{ Code = $process.ExitCode; Output = $text.ToString().Trim(); ErrorCode = $errorCode }
    } finally {
        if (-not $process.HasExited) { Stop-OwnedProcess $process }
        $process.Dispose()
    }
}

function Test-CompatiblePython {
    param([string]$File, [string[]]$Prefix = @())
    try {
        $probe = 'import sys,struct; print(sys.executable if (3,10) <= sys.version_info[:2] <= (3,12) and struct.calcsize("P") == 8 else "")'
        $result = Invoke-SetupProcess -File $File -Arguments ($Prefix + @('-I', '-X', 'utf8', '-c', $probe)) -TimeoutSeconds 20
        if ($result.Code -eq 0 -and $result.Output -match '^[A-Za-z]:[\\/]' -and (Test-Path -LiteralPath $result.Output -PathType Leaf)) {
            Assert-NoReparse $result.Output
            return $result.Output
        }
    } catch { }
    return $null
}

function Remove-OwnedTemporary {
    param([string]$Path)
    $fullPath = [IO.Path]::GetFullPath($Path)
    if ([IO.Path]::GetDirectoryName($fullPath) -ne $script:SetupRoot -or [IO.Path]::GetFileName($fullPath) -notmatch '^\.setup-bootstrap-[a-f0-9]{32}$') {
        throw 'Unexpected setup cleanup path'
    }
    Assert-NoReparse $fullPath
    if (Test-Path -LiteralPath $fullPath) {
        $marker = Join-Path $fullPath '.owned-bootstrap'
        if (-not (Test-Path -LiteralPath $marker -PathType Leaf)) { return }
        Assert-NoReparse $marker
        $ownership = 'voice-diary-sensevoice-bootstrap-v1'
        if ((Get-Item -LiteralPath $marker).Length -ne $ownership.Length -or [IO.File]::ReadAllText($marker) -ne $ownership) { return }
        foreach ($item in Get-ChildItem -LiteralPath $fullPath -Recurse -Force) { Assert-NoReparse $item.FullName }
        Remove-Item -LiteralPath $fullPath -Recurse -Force
    }
}

function Invoke-SenseVoiceSetup {
param([string]$SetupPath)
$script:Phase = 'root'
$script:Lock = $null
$script:Temporary = $null
try {
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or -not [Environment]::Is64BitOperatingSystem -or $SetupPath -notmatch '^[A-Za-z]:[\\/]' -or $SetupPath.Contains('"')) { throw 'A Windows x64 local root is required' }
    $script:SetupRoot = [IO.Path]::GetFullPath($SetupPath).TrimEnd('\', '/')
    if ($script:SetupRoot.Length -le 3) { throw 'A setup subdirectory is required' }
    Assert-NoReparse $script:SetupRoot
    [void][IO.Directory]::CreateDirectory($script:SetupRoot)
    $lockPath = Join-Path $script:SetupRoot '.setup.lock'
    Assert-NoReparse $lockPath
    $script:Phase = 'busy'
    $script:Lock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    $script:Phase = 'root'
    # A forced cancellation may have skipped finally. These exact owned children
    # contain only bootstrap downloads and are safe to discard after locking.
    foreach ($old in Get-ChildItem -LiteralPath $script:SetupRoot -Directory -Force) {
        if ($old.Name -match '^\.setup-bootstrap-[a-f0-9]{32}$') { Remove-OwnedTemporary $old.FullName }
    }
    $script:Temporary = Join-Path $script:SetupRoot ('.setup-bootstrap-' + [Guid]::NewGuid().ToString('N'))
    [void][IO.Directory]::CreateDirectory($script:Temporary)
    [IO.File]::WriteAllText((Join-Path $script:Temporary '.owned-bootstrap'), 'voice-diary-sensevoice-bootstrap-v1', (New-Object Text.UTF8Encoding($false)))
    $script:Phase = 'python'
    Write-SetupEvent -Event 'progress' -Stage 'python'
    $environmentPython = Join-Path $script:SetupRoot '.venv\Scripts\python.exe'
    Assert-NoReparse $environmentPython
    $python = Test-CompatiblePython $environmentPython
    if (-not $python) {
        $basePython = Test-CompatiblePython (Join-Path $script:SetupRoot 'python312\python.exe')
        if (-not $basePython) {
            $launcher = Get-Command py.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($launcher) {
                foreach ($version in @('-3.12', '-3.11', '-3.10')) {
                    $basePython = Test-CompatiblePython -File $launcher.Source -Prefix @($version)
                    if ($basePython) { break }
                }
            }
        }
        if (-not $basePython) {
            $command = Get-Command python.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($command -and $command.Source -notmatch '\\WindowsApps\\') { $basePython = Test-CompatiblePython $command.Source }
        }
        if (-not $basePython) {
            # Reuse compatible PEP 514 installs even when neither Python nor its
            # launcher is on PATH. The fallback EXE is a per-user installation:
            # no PATH/association changes, but it can register with an existing py.
            foreach ($hive in @('HKCU:', 'HKLM:')) {
                foreach ($version in @('3.12', '3.11', '3.10')) {
                    $registration = Join-Path $hive ('Software\Python\PythonCore\' + $version + '\InstallPath')
                    if (Test-Path -LiteralPath $registration) {
                        $registered = Get-Item -LiteralPath $registration
                        $location = $registered.GetValue('')
                        if ($location) { $basePython = Test-CompatiblePython (Join-Path $location 'python.exe') }
                        if ($basePython) { break }
                    }
                }
                if ($basePython) { break }
            }
        }
        if (-not $basePython) {
            [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
            $installer = Join-Path $script:Temporary 'python-3.12.10-amd64.exe'
            Invoke-WebRequest -UseBasicParsing -Uri $script:PythonInstallerUrl -OutFile $installer -TimeoutSec 300
            $signature = Get-AuthenticodeSignature -LiteralPath $installer
            if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch '(^|,\s*)O=Python Software Foundation(,|$)') {
                throw 'Python installer signature verification failed'
            }
            $runtime = Join-Path $script:SetupRoot 'python312'
            Assert-NoReparse $runtime
            $installed = Invoke-SetupProcess -File $installer -Arguments @('/quiet', 'InstallAllUsers=0', 'PrependPath=0', 'AppendPath=0',
                'Include_launcher=0', 'AssociateFiles=0', 'Shortcuts=0', 'Include_test=0', 'Include_pip=1', 'Include_tcltk=0',
                ('TargetDir=' + $runtime)) -TimeoutSeconds 900
            if ($installed.Code -notin @(0, 3010)) { throw 'Python installation failed' }
            $basePython = Test-CompatiblePython (Join-Path $runtime 'python.exe')
            if (-not $basePython) { throw 'Python installation validation failed' }
        }
        $created = Invoke-SetupProcess -File $basePython -Arguments @('-I', '-X', 'utf8', '-m', 'venv', (Join-Path $script:SetupRoot '.venv')) -TimeoutSeconds 180
        if ($created.Code -ne 0) { throw 'Could not create an isolated Python environment' }
        $python = Test-CompatiblePython $environmentPython
        if (-not $python) { throw 'Isolated Python environment is unavailable' }
    }
    $script:Phase = 'dependencies'
    Write-SetupEvent -Event 'progress' -Stage 'dependencies'
    $check = 'import importlib.metadata as m; wanted={"sherpa-onnx":"1.12.40","sherpa-onnx-core":"1.12.40","numpy":"1.26.4","imageio-ffmpeg":"0.6.0"}; assert all(m.version(k)==v for k,v in wanted.items()); import sherpa_onnx,numpy,imageio_ffmpeg'
    $dependencies = Invoke-SetupProcess -File $python -Arguments @('-I', '-X', 'utf8', '-c', $check) -TimeoutSeconds 60
    if ($dependencies.Code -ne 0) {
        $requirements = Join-Path $PSScriptRoot 'requirements-sensevoice.txt'
        $installed = Invoke-SetupProcess -File $python -Arguments @('-I', '-X', 'utf8', '-m', 'pip', '--isolated', '--disable-pip-version-check',
            'install', '--quiet', '--no-input', '--no-cache-dir', '--only-binary=:all:', '--index-url', 'https://pypi.org/simple', '-r', $requirements) -TimeoutSeconds 1200
        if ($installed.Code -ne 0) { throw 'Could not install pinned dependencies' }
        $dependencies = Invoke-SetupProcess -File $python -Arguments @('-I', '-X', 'utf8', '-c', $check) -TimeoutSeconds 60
        if ($dependencies.Code -ne 0) { throw 'Dependency validation failed' }
    }
    $script:Phase = 'model'
    $prepared = Invoke-SetupProcess -File $python -Arguments @('-I', '-X', 'utf8', '-B', '-u', (Join-Path $PSScriptRoot 'setup_sensevoice.py'), '--root', $script:SetupRoot) -TimeoutSeconds 1200 -Protocol
    if ($prepared.Code -ne 0) {
        if ($prepared.ErrorCode) { $script:Phase = $prepared.ErrorCode }
        throw 'Model download or verification failed'
    }
    Write-SetupEvent -Event 'ready'
    return 0
} catch {
    if ($script:Phase -notin @('root', 'python', 'dependencies', 'download', 'model', 'busy', 'runtime')) { $script:Phase = 'runtime' }
    Write-SetupEvent -Event 'error' -Code $script:Phase
    return 1
} finally {
    if ($script:Temporary) { try { Remove-OwnedTemporary $script:Temporary } catch { } }
    if ($script:Lock) { $script:Lock.Dispose() }
}
}

# Dot-sourcing defines the functions for offline tests and manual inspection.
if ($MyInvocation.InvocationName -ne '.') { exit (Invoke-SenseVoiceSetup -SetupPath $Root) }
