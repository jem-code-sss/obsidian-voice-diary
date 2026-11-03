# Offline PowerShell bootstrap regressions. No installer, pip or model downloads.
param([string]$PythonPath = 'python.exe')
$ErrorActionPreference = 'Stop'
$setupSource = Join-Path (Split-Path $PSScriptRoot -Parent) 'runtime\setup-sensevoice.ps1'
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('sensevoice-bootstrap-tests-' + [Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($testRoot)
$script:Passed = 0

function Assert-True { param($Value, [string]$Message); if (-not $Value) { throw $Message } }
function Assert-Equal { param($Actual, $Expected); if ($Actual -cne $Expected) { throw ('Expected ' + $Expected + ', got ' + $Actual) } }
function Capture-Setup {
    param([scriptblock]$Action)
    $original = [Console]::Out
    $output = New-Object IO.StringWriter
    try {
        [Console]::SetOut($output)
        $code = & $Action
        return [pscustomobject]@{ Code = $code; Events = @($output.ToString().Trim() -split '\r?\n' | Where-Object { $_ } | ForEach-Object { $_ | ConvertFrom-Json }) }
    } finally { [Console]::SetOut($original); $output.Dispose() }
}
function Test-Case {
    param([string]$Name, [scriptblock]$Action)
    # Fresh function definitions avoid carrying mocks from one case to the next.
    . $setupSource
    & $Action
    $script:Passed++
    Write-Output ('PASS ' + $Name)
}

try {
    Test-Case 'actual process arguments preserve spaces, quotes, Unicode and trailing backslashes' {
        $script:SetupRoot = $testRoot
        $values = @('with spaces', 'trailing\', 'embedded "quotes"', '中文', 'ends with slash\\', '')
        $result = Invoke-SetupProcess -File $PythonPath -Arguments (@('-I', '-c', 'import sys,json; print(json.dumps(sys.argv[1:],ensure_ascii=True))') + $values) -TimeoutSeconds 20
        Assert-Equal $result.Code 0
        $actual = $result.Output | ConvertFrom-Json
        Assert-Equal $actual.Count $values.Count
        for ($index = 0; $index -lt $values.Count; $index++) { Assert-Equal $actual[$index] $values[$index] }
    }

    Test-Case 'only fixed progress protocol fields reach stdout' {
        $script:SetupRoot = $testRoot
        $code = 'print(''private path and API token''); print(''{"event":"progress","stage":"model","pct":20,"path":"private"}''); print(''{"event":"progress","stage":"unknown","pct":90}''); print(''{"event":"ready","path":"private"}'')'
        $captured = Capture-Setup { $result = Invoke-SetupProcess -File $PythonPath -Arguments @('-I', '-c', $code) -TimeoutSeconds 20 -Protocol; $result.Code }
        Assert-Equal $captured.Code 0
        Assert-Equal $captured.Events.Count 1
        Assert-Equal ($captured.Events[0] | ConvertTo-Json -Compress) '{"event":"progress","stage":"model","pct":20}'
    }

    Test-Case 'Windows PowerShell reads Python UTF-8 and locates a Unicode environment root' {
        $script:SetupRoot = $testRoot
        # Character codes keep this fixture identical when Windows PowerShell 5.1
        # reads a UTF-8 source file on a machine with a legacy ANSI code page.
        $suffix = [string][char]0x6D4B + [char]0x8BD5
        $unicodeRoot = Join-Path $testRoot ('unicode-' + $suffix)
        $created = Invoke-SetupProcess -File $PythonPath -Arguments @('-I', '-m', 'venv', '--without-pip', $unicodeRoot) -TimeoutSeconds 30
        Assert-Equal $created.Code 0
        $environment = Join-Path $unicodeRoot 'Scripts\python.exe'
        Assert-Equal (Test-CompatiblePython $environment) $environment
    }

    Test-Case 'timeout ends only the process held by the helper' {
        $script:SetupRoot = $testRoot
        $timedOut = $false
        $clock = [Diagnostics.Stopwatch]::StartNew()
        try { [void](Invoke-SetupProcess -File $PythonPath -Arguments @('-I', '-c', 'import time; time.sleep(60)') -TimeoutSeconds 1) }
        catch { $timedOut = $true }
        Assert-True $timedOut 'Expected timeout'
        Assert-True ($clock.Elapsed.TotalSeconds -lt 12) 'Owned process did not terminate promptly'
    }

    Test-Case 'UNC and drive root are rejected without private output' {
        foreach ($invalid in @('\\server\share\private', 'C:\', 'relative\private', 'C:\private"quoted')) {
            $result = Capture-Setup { Invoke-SenseVoiceSetup -SetupPath $invalid }
            Assert-Equal $result.Code 1
            Assert-Equal $result.Events.Count 1
            Assert-Equal ($result.Events[0] | ConvertTo-Json -Compress) '{"event":"error","code":"root"}'
        }
    }

    Test-Case 'exclusive root lock rejects simultaneous setup without mutation' {
        $fixture = Join-Path $testRoot 'locked'
        [void][IO.Directory]::CreateDirectory($fixture)
        $held = [IO.File]::Open((Join-Path $fixture '.setup.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
        try {
            $result = Capture-Setup { Invoke-SenseVoiceSetup -SetupPath $fixture }
            Assert-Equal $result.Code 1
            Assert-Equal ($result.Events[0] | ConvertTo-Json -Compress) '{"event":"error","code":"busy"}'
            Assert-Equal @(Get-ChildItem -LiteralPath $fixture -Force).Count 1
        } finally { $held.Dispose() }
    }

    Test-Case 'healthy existing environment skips pip and forwards fixed model result' {
        $fixture = Join-Path $testRoot 'healthy'
        function Test-CompatiblePython { param($File, $Prefix); return (Join-Path $fixture '.venv\Scripts\python.exe') }
        $script:Calls = @()
        function Invoke-SetupProcess {
            param($File, $Arguments, $TimeoutSeconds, [switch]$Protocol)
            $script:Calls += ,$Arguments
            return [pscustomobject]@{ Code = 0; Output = ''; ErrorCode = '' }
        }
        $result = Capture-Setup { Invoke-SenseVoiceSetup -SetupPath $fixture }
        Assert-Equal $result.Code 0
        Assert-Equal $script:Calls.Count 2
        Assert-True (-not (@($script:Calls | ForEach-Object { $_ }) -contains 'pip')) 'Healthy setup unexpectedly invoked pip'
        Assert-True ($script:Calls[1] -contains '--root') 'Model script did not receive an explicit root'
        Assert-Equal $result.Events[-1].event 'ready'
        Assert-Equal @(Get-ChildItem -LiteralPath $fixture -Directory -Force).Count 0
    }

    Test-Case 'dependencies are pinned, binary-only and fetched from PyPI on demand' {
        $fixture = Join-Path $testRoot 'dependencies'
        function Test-CompatiblePython { param($File, $Prefix); return (Join-Path $fixture '.venv\Scripts\python.exe') }
        $script:Checks = 0
        $script:PipArguments = $null
        function Invoke-SetupProcess {
            param($File, $Arguments, $TimeoutSeconds, [switch]$Protocol)
            if ($Arguments -contains 'pip') { $script:PipArguments = $Arguments }
            elseif ($Arguments -contains '-c') {
                $script:Checks++
                if ($script:Checks -eq 1) { return [pscustomobject]@{ Code = 1; Output = ''; ErrorCode = '' } }
            }
            return [pscustomobject]@{ Code = 0; Output = ''; ErrorCode = '' }
        }
        $result = Capture-Setup { Invoke-SenseVoiceSetup -SetupPath $fixture }
        Assert-Equal $result.Code 0
        foreach ($expected in @('--isolated', '--only-binary=:all:', '--no-input', '--no-cache-dir', 'https://pypi.org/simple')) {
            Assert-True ($script:PipArguments -contains $expected) ('Missing pip restriction ' + $expected)
        }
        Assert-True ($script:PipArguments[-1].EndsWith('requirements-sensevoice.txt')) 'Pinned requirements missing'
        Assert-Equal $script:Checks 2
    }

    Test-Case 'Python installer with untrusted signature never executes' {
        $fixture = Join-Path $testRoot 'signature'
        function Test-CompatiblePython { param($File, $Prefix); return $null }
        function Get-Command { param($Name, $CommandType, $ErrorAction); return $null }
        $script:SignatureChecked = $false
        function Invoke-WebRequest { param([switch]$UseBasicParsing, $Uri, $OutFile, $TimeoutSec); [IO.File]::WriteAllText($OutFile, 'fake downloaded executable') }
        function Get-AuthenticodeSignature { param($LiteralPath); $script:SignatureChecked = $true; return [pscustomobject]@{ Status = 'NotSigned'; SignerCertificate = $null } }
        function Invoke-SetupProcess { throw 'Untrusted installer must never execute' }
        # Suppress discovery of real registered Python so this exercises fallback.
        function Test-Path { param($LiteralPath, $PathType); if ($LiteralPath -match '^HK') { return $false }; return Microsoft.PowerShell.Management\Test-Path -LiteralPath $LiteralPath }
        $result = Capture-Setup { Invoke-SenseVoiceSetup -SetupPath $fixture }
        Assert-Equal $result.Code 1
        Assert-Equal $result.Events[-1].code 'python'
        Assert-True $script:SignatureChecked 'The installer signature was not checked'
        Assert-Equal @(Get-ChildItem -LiteralPath $fixture -Directory -Force).Count 0
    }

    Test-Case 'verified official Python fallback is per-user, isolated and never adds PATH or associations' {
        $fixture = Join-Path $testRoot 'signed fallback with spaces'
        $script:BaseReady = $false
        $script:EnvironmentReady = $false
        $script:InstallerArguments = $null
        function Test-CompatiblePython {
            param($File, $Prefix)
            if ($File.EndsWith('python312\python.exe') -and $script:BaseReady) { return $File }
            if ($File.EndsWith('.venv\Scripts\python.exe') -and $script:EnvironmentReady) { return $File }
            return $null
        }
        function Get-Command { param($Name, $CommandType, $ErrorAction); return $null }
        function Test-Path { param($LiteralPath, $PathType); if ($LiteralPath -match '^HK') { return $false }; return Microsoft.PowerShell.Management\Test-Path -LiteralPath $LiteralPath }
        function Invoke-WebRequest {
            param([switch]$UseBasicParsing, $Uri, $OutFile, $TimeoutSec)
            Assert-Equal $Uri 'https://www.python.org/ftp/python/3.12.10/python-3.12.10-amd64.exe'
            [IO.File]::WriteAllText($OutFile, 'fake signed executable')
        }
        function Get-AuthenticodeSignature {
            param($LiteralPath)
            return [pscustomobject]@{ Status = 'Valid'; SignerCertificate = [pscustomobject]@{ Subject = 'CN=Python Software Foundation, O=Python Software Foundation, C=US' } }
        }
        function Invoke-SetupProcess {
            param($File, $Arguments, $TimeoutSeconds, [switch]$Protocol)
            if ($File.EndsWith('python-3.12.10-amd64.exe')) { $script:InstallerArguments = $Arguments; $script:BaseReady = $true }
            if ($Arguments -contains 'venv') { $script:EnvironmentReady = $true }
            return [pscustomobject]@{ Code = 0; Output = ''; ErrorCode = '' }
        }
        $result = Capture-Setup { Invoke-SenseVoiceSetup -SetupPath $fixture }
        Assert-Equal $result.Code 0
        foreach ($expected in @('InstallAllUsers=0', 'PrependPath=0', 'AppendPath=0', 'Include_launcher=0', 'AssociateFiles=0', 'Shortcuts=0')) {
            Assert-True ($script:InstallerArguments -contains $expected) ('Missing per-user install flag ' + $expected)
        }
        Assert-True ($script:InstallerArguments -contains ('TargetDir=' + (Join-Path $fixture 'python312'))) 'Python target escaped the managed root'
        Assert-Equal $result.Events[-1].event 'ready'
    }

    Test-Case 'upstream error code is safe and never promoted to success' {
        $fixture = Join-Path $testRoot 'model-failed'
        function Test-CompatiblePython { param($File, $Prefix); return (Join-Path $fixture '.venv\Scripts\python.exe') }
        function Invoke-SetupProcess {
            param($File, $Arguments, $TimeoutSeconds, [switch]$Protocol)
            if ($Protocol) { return [pscustomobject]@{ Code = 1; Output = 'private internals'; ErrorCode = 'download' } }
            return [pscustomobject]@{ Code = 0; Output = ''; ErrorCode = '' }
        }
        $result = Capture-Setup { Invoke-SenseVoiceSetup -SetupPath $fixture }
        Assert-Equal $result.Code 1
        Assert-Equal $result.Events[-1].code 'download'
        Assert-True (-not (@($result.Events | ForEach-Object { $_.event }) -contains 'ready')) 'Failure reported ready'
    }

    Test-Case 'cleanup stays within exact root and requires an ownership marker' {
        $script:SetupRoot = Join-Path $testRoot 'cleanup'
        [void][IO.Directory]::CreateDirectory($script:SetupRoot)
        $owned = Join-Path $script:SetupRoot ('.setup-bootstrap-' + ('a' * 32))
        $unowned = Join-Path $script:SetupRoot ('.setup-bootstrap-' + ('b' * 32))
        [void][IO.Directory]::CreateDirectory($owned)
        [void][IO.Directory]::CreateDirectory($unowned)
        [IO.File]::WriteAllText((Join-Path $owned '.owned-bootstrap'), 'voice-diary-sensevoice-bootstrap-v1', (New-Object Text.UTF8Encoding($false)))
        [IO.File]::WriteAllText((Join-Path $owned 'download.part'), 'partial')
        Remove-OwnedTemporary $owned
        Remove-OwnedTemporary $unowned
        Assert-True (-not (Test-Path -LiteralPath $owned)) 'Owned partial was not cleaned'
        Assert-True (Test-Path -LiteralPath $unowned) 'Unowned directory was removed'
        $blocked = $false
        try { Remove-OwnedTemporary $testRoot } catch { $blocked = $true }
        Assert-True $blocked 'Cleanup escaped the exact owned child'
    }
    Write-Output ('Passed ' + $script:Passed + ' PowerShell bootstrap tests; all network calls mocked.')
} finally {
    $resolved = [IO.Path]::GetFullPath($testRoot)
    if ([IO.Path]::GetDirectoryName($resolved) -eq [IO.Path]::GetTempPath().TrimEnd('\', '/') -and [IO.Path]::GetFileName($resolved) -match '^sensevoice-bootstrap-tests-[a-f0-9]{32}$') {
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
