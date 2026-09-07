<#
  smtc-bridge.ps1
  Long-lived bridge between Windows' System Media Transport Controls and the
  Electron app. Emits one compact JSON object per line on stdout whenever the
  media state changes, and accepts single-line commands on stdin.

  Commands: playpause | play | pause | next | prev | seek <ms> | ping | quit
#>

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null

# Force the WinRT projections we need to load.
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime]

# --- WinRT async -> synchronous ------------------------------------------------
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and
        $_.GetParameters().Count -eq 1 -and
        $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    })[0]

function Await {
    param($Operation, [Type] $ResultType)
    $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
    $task = $asTask.Invoke($null, @($Operation))
    if (-not $task.Wait(8000)) { throw 'WinRT operation timed out' }
    return $task.Result
}

function Emit {
    param($Object)
    [Console]::Out.WriteLine(($Object | ConvertTo-Json -Compress -Depth 6))
    [Console]::Out.Flush()
}

function Emit-Log {
    param([string] $Level, [string] $Message)
    Emit ([pscustomobject]@{ type = 'log'; level = $Level; message = $Message })
}

# --- Types ---------------------------------------------------------------------
$T_Manager = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$T_Props = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType = WindowsRuntime]
$T_Stream = [Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType = WindowsRuntime]
$T_Bool = [bool]
$T_UInt = [uint32]

# --- Artwork -------------------------------------------------------------------
$ArtDir = Join-Path $env:TEMP 'spotifs-art'
New-Item -ItemType Directory -Force -Path $ArtDir | Out-Null

function Get-KeyHash {
    param([string] $Text)
    $md5 = [System.Security.Cryptography.MD5]::Create()
    $bytes = $md5.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($Text))
    $md5.Dispose()
    return -join ($bytes | ForEach-Object { $_.ToString('x2') })
}

function Save-Thumbnail {
    param($Properties, [string] $Path)
    if ($null -eq $Properties -or $null -eq $Properties.Thumbnail) { return $false }
    if (Test-Path -LiteralPath $Path) { return $true }
    $stream = $null; $reader = $null
    try {
        $stream = Await ($Properties.Thumbnail.OpenReadAsync()) $T_Stream
        $size = [uint32] $stream.Size
        if ($size -eq 0) { return $false }
        $reader = [Windows.Storage.Streams.DataReader]::new($stream.GetInputStreamAt(0))
        $null = Await ($reader.LoadAsync($size)) $T_UInt
        $buffer = New-Object byte[] $size
        $reader.ReadBytes($buffer)
        [System.IO.File]::WriteAllBytes($Path, $buffer)
        return $true
    } catch {
        return $false
    } finally {
        if ($reader) { $reader.Dispose() }
        if ($stream) { $stream.Dispose() }
    }
}

# --- Session handling ----------------------------------------------------------
$script:Manager = $null
$script:Session = $null
$script:LastSessions = '~'

function Ensure-Manager {
    if ($null -ne $script:Manager) { return }
    $script:Manager = Await ($T_Manager::RequestAsync()) $T_Manager
}

function Resolve-Session {
    Ensure-Manager
    $sessions = @($script:Manager.GetSessions())

    # Report the session list whenever it changes; the only useful clue when the
    # app says "nothing playing" is whether Windows is offering a session at all.
    $names = ($sessions | ForEach-Object { $_.SourceAppUserModelId }) -join ', '
    if ($names -ne $script:LastSessions) {
        $script:LastSessions = $names
        Emit-Log 'info' ('sessions: ' + $(if ($names) { $names } else { '(none)' }))
    }

    if ($sessions.Count -eq 0) { $script:Session = $null; return }

    # Prefer Spotify; fall back to whatever Windows considers current.
    $spotify = $sessions | Where-Object { $_.SourceAppUserModelId -match '(?i)spotify' } | Select-Object -First 1
    if ($spotify) { $script:Session = $spotify; return }

    $current = $script:Manager.GetCurrentSession()
    $script:Session = if ($current) { $current } else { $sessions[0] }
}

$StatusNames = @{ 0 = 'closed'; 1 = 'opened'; 2 = 'changing'; 3 = 'stopped'; 4 = 'playing'; 5 = 'paused' }

function Invoke-Command-Line {
    param([string] $Line)
    $line = $Line.Trim()
    if ($line -eq 'quit') { exit 0 }
    if ($line -eq 'ping') { Emit ([pscustomobject]@{ type = 'pong' }); return }

    $s = $script:Session
    if ($null -eq $s) { return }

    try {
        switch -Regex ($line) {
            '^playpause$' { $null = Await ($s.TryTogglePlayPauseAsync()) $T_Bool }
            '^play$' { $null = Await ($s.TryPlayAsync()) $T_Bool }
            '^pause$' { $null = Await ($s.TryPauseAsync()) $T_Bool }
            '^next$' { $null = Await ($s.TrySkipNextAsync()) $T_Bool }
            '^prev(ious)?$' { $null = Await ($s.TrySkipPreviousAsync()) $T_Bool }
            '^seek\s+(\d+)$' {
                $ticks = [int64] $Matches[1] * 10000
                $null = Await ($s.TryChangePlaybackPositionAsync($ticks)) $T_Bool
            }
            default { }
        }
    } catch {
        Emit-Log 'warn' ("command '$line' failed: " + $_.Exception.Message)
    }
}

# --- Main loop -----------------------------------------------------------------
# [Console]::In is a SyncTextReader, whose ReadLineAsync runs *synchronously* --
# it would block this loop until the parent sent a command, and the parent has
# nothing to say until the user presses a button. Read the raw standard-input
# stream instead, where ReadLineAsync is genuinely asynchronous.
$stdinStream = [Console]::OpenStandardInput()
$stdin = New-Object System.IO.StreamReader($stdinStream, (New-Object System.Text.UTF8Encoding($false)))
$pendingRead = $null

$lastPayload = ''
$lastHeartbeat = 0
$lastPropsAt = 0
$lastSessionAt = 0
$properties = $null
$trackKey = ''
$artPath = ''

Emit ([pscustomobject]@{ type = 'ready' })

while ($true) {
    # ---- stdin (non-blocking) ----
    if ($null -eq $pendingRead) { $pendingRead = $stdin.ReadLineAsync() }
    if ($pendingRead.IsCompleted) {
        $line = $pendingRead.Result
        $pendingRead = $null
        if ($null -eq $line) { break }   # parent closed the pipe
        if ($line.Length -gt 0) { Invoke-Command-Line $line }
        continue                          # drain queued commands promptly
    }

    $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()

    try {
        if ($now - $lastSessionAt -ge 1000 -or $null -eq $script:Session) {
            Resolve-Session
            $lastSessionAt = $now
        }

        $s = $script:Session
        if ($null -eq $s) {
            $payload = [pscustomobject]@{ type = 'state'; hasSession = $false }
        } else {
            $playback = $s.GetPlaybackInfo()
            $timeline = $s.GetTimelineProperties()

            if ($now - $lastPropsAt -ge 900 -or $null -eq $properties) {
                $properties = Await ($s.TryGetMediaPropertiesAsync()) $T_Props
                $lastPropsAt = $now
            }

            $title = if ($properties.Title) { $properties.Title } else { '' }
            $artist = if ($properties.Artist) { $properties.Artist } else { '' }
            $album = if ($properties.AlbumTitle) { $properties.AlbumTitle } else { '' }
            $key = "$title|$artist|$album"

            if ($key -ne $trackKey) {
                $trackKey = $key
                $artPath = ''
                if ($key.Trim('|').Length -gt 0) {
                    $candidate = Join-Path $ArtDir ((Get-KeyHash $key) + '.jpg')
                    if (Save-Thumbnail $properties $candidate) { $artPath = $candidate }
                }
            }

            $startTicks = $timeline.StartTime.Ticks
            $positionMs = [int64] (($timeline.Position.Ticks - $startTicks) / 10000)
            $durationMs = [int64] (($timeline.EndTime.Ticks - $startTicks) / 10000)
            if ($positionMs -lt 0) { $positionMs = 0 }
            if ($durationMs -lt 0) { $durationMs = 0 }

            $updatedAt = 0
            try { $updatedAt = [int64] $timeline.LastUpdatedTime.ToUnixTimeMilliseconds() } catch { $updatedAt = $now }
            if ($updatedAt -le 0) { $updatedAt = $now }

            $statusCode = [int] $playback.PlaybackStatus
            $controls = $playback.Controls

            $payload = [pscustomobject]@{
                type        = 'state'
                hasSession  = $true
                source      = [string] $s.SourceAppUserModelId
                title       = $title
                artist      = $artist
                album       = $album
                art         = $artPath
                status      = $(if ($StatusNames.ContainsKey($statusCode)) { $StatusNames[$statusCode] } else { 'unknown' })
                positionMs  = $positionMs
                durationMs  = $durationMs
                updatedAt   = $updatedAt
                serverNow   = $now
                canSeek     = [bool] $controls.IsPlaybackPositionEnabled
                canNext     = [bool] $controls.IsNextEnabled
                canPrevious = [bool] $controls.IsPreviousEnabled
            }
        }

        $json = $payload | ConvertTo-Json -Compress -Depth 6
        if ($json -ne $lastPayload -or ($now - $lastHeartbeat) -ge 5000) {
            [Console]::Out.WriteLine($json)
            [Console]::Out.Flush()
            $lastPayload = $json
            $lastHeartbeat = $now
        }
    } catch {
        Emit-Log 'error' $_.Exception.Message
        $script:Manager = $null
        $script:Session = $null
        $properties = $null
        Start-Sleep -Milliseconds 1200
    }

    Start-Sleep -Milliseconds 220
}
