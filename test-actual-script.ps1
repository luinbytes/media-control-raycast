# Extract and test the actual PowerShell script from mediaUtils.ts
# This is the exact script that should be running in the extension

# Known media applications and their patterns (mirrors mediaUtils.ts)
$mediaApps = @{
    "spotify" = @{
        "displayName" = "Spotify"
        "titlePattern" = "^(.+) - (.+)( - .+)?$"
        "pausedPattern" = "^Spotify( Premium| Free)?$"
    }
    "chrome" = @{
        "displayName" = "Chrome"
        "titlePattern" = "^(.+) - YouTube - Google Chrome$"
        "pausedPattern" = ".*YouTube.*Google Chrome$"
    }
    "brave" = @{
        "displayName" = "Brave"
        "titlePattern" = "^(.+) - YouTube - Brave$"
        "pausedPattern" = ".*YouTube.*Brave$"
    }
    "msedge" = @{
        "displayName" = "Microsoft Edge"
        "titlePattern" = "^(.+) - YouTube - Microsoft.*Edge$"
        "pausedPattern" = ".*YouTube.*Microsoft.*Edge$"
    }
    "firefox" = @{
        "displayName" = "Firefox"
        "titlePattern" = "^(.+) - YouTube - Mozilla Firefox$"
        "pausedPattern" = ".*YouTube.*Mozilla Firefox$"
    }
    "zen" = @{
        "displayName" = "Zen Browser"
        # Support em dash \u2014, en dash \u2013, or hyphen
        "titlePattern" = "^(.+) - YouTube (\u2014|-|\u2013) Zen Browser$"
        "pausedPattern" = ".*YouTube.*Zen Browser$"
    }
    "vlc" = @{
        "displayName" = "VLC Media Player"
        "titlePattern" = "^(.+) - VLC media player$"
        "pausedPattern" = "^VLC media player$"
    }
    "wmplayer" = @{
        "displayName" = "Windows Media Player"
        "titlePattern" = "^(.+) - Windows Media Player$"
        "pausedPattern" = "^Windows Media Player$"
    }
    "iTunes" = @{
        "displayName" = "iTunes"
        "titlePattern" = "^(.+) - (.+) - iTunes$"
        "pausedPattern" = "^iTunes$"
    }
}

Write-Host "=== Testing Actual Media Detection Script ==="

# Get all running processes with a main window title
$processes = Get-Process | Where-Object { $_.MainWindowTitle -ne "" }
Write-Host "Found $($processes.Count) processes with window titles"

# Priorities: lower is better
$candidates = @()

# Determine foreground process name for bonus
Add-Type -Namespace Win32 -Name Native -MemberDefinition @"
    [System.Runtime.InteropServices.DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();
    [System.Runtime.InteropServices.DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr hWnd, out uint lpdwProcessId);
"@
$hWnd = [Win32.Native]::GetForegroundWindow()
$fgPid = 0
[Win32.Native]::GetWindowThreadProcessId($hWnd, [ref]$fgPid) | Out-Null
$ForegroundProcessName = $null
if ($fgPid -ne 0) {
    try { $ForegroundProcessName = (Get-Process -Id $fgPid -ErrorAction Stop).ProcessName.ToLower() } catch {}
}
Write-Host "Foreground process: $ForegroundProcessName"

# Helper to wait WinRT IAsyncOperation without WindowsRuntimeSystemExtensions
function Wait-AsyncOperation {
    param(
        [Parameter(Mandatory=$true)] $Operation,
        [int] $TimeoutMs = 5000,
        [int] $PollMs = 50
    )
    if ($null -eq $Operation) { return $null }
    if (-not ($Operation | Get-Member -Name Status -ErrorAction SilentlyContinue)) { return $null }
    $elapsed = 0
    while ($Operation.Status.ToString() -eq 'Started' -and $elapsed -lt $TimeoutMs) {
        Start-Sleep -Milliseconds $PollMs
        $elapsed += $PollMs
    }
    if ($Operation.Status.ToString() -eq 'Completed') {
        return $Operation.GetResults()
    } else {
        Write-Host "SMTC: Async op did not complete (Status=$($Operation.Status))"
        return $null
    }
}

# Try SMTC (Global System Media Transport Controls) first
function Get-SmtcCandidates {
    param()
    $localCandidates = @()
    try {
        $mgrOp = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime]::RequestAsync()
        if ($null -eq $mgrOp) { Write-Host "SMTC: RequestAsync() returned null"; return ,$localCandidates }
        $mgr = Wait-AsyncOperation -Operation $mgrOp
        if ($null -eq $mgr) { Write-Host "SMTC: Manager unavailable (GetResults null)"; return ,$localCandidates }
        if ($mgr -ne $null) {
            $sessions = $mgr.GetSessions()
            Write-Host "SMTC: Manager acquired. Sessions=$($sessions.Count)"
            foreach ($s in $sessions) {
                try {
                    $info = $s.GetPlaybackInfo()
                    $status = $info.PlaybackStatus
                    $propsOp = $s.TryGetMediaPropertiesAsync()
                    $props = Wait-AsyncOperation -Operation $propsOp
                    $appId = ($s.SourceAppUserModelId | Out-String).Trim()
                    $titleSm = ($props.Title | Out-String).Trim()
                    $artistSm = ($props.Artist | Out-String).Trim()
                    $albumSm = ($props.AlbumTitle | Out-String).Trim()

                    Write-Host "SMTC: AppId='$appId' Status=$status Title='${titleSm}'"
                    if (-not $titleSm) { Write-Host "SMTC: Skipping (empty title)"; continue }

                    $isPlaying = ($status -eq [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionPlaybackStatus]::Playing)

                    # Identify app from AUMID
                    $appLower = $appId.ToLower()
                    $isBrowser = ($appLower -match 'chrome|brave|edge|firefox|zen')
                    $isSpotify = ($appLower -match 'spotify')

                    $sessionInfo = @{
                        Title = $titleSm
                        Artist = (if ($artistSm) { $artistSm } elseif ($isSpotify) { "Spotify" } elseif ($isBrowser) { "YouTube" } else { $appId })
                        Album = (if ($albumSm) { $albumSm } else { $null })
                        AppName = $appId
                        IsPlaying = $isPlaying
                        CanPlay = $true
                        CanPause = $true
                        CanSkipNext = $true
                        CanSkipPrevious = $true
                        Duration = $null
                        Position = $null
                        Genre = $null
                    }

                    # Scoring: prefer playing; base by type; live bonus; foreground bonus
                    $base = if ($isSpotify) { 80 } elseif ($isBrowser) { 75 } else { 78 }
                    $bonusLive = if ($sessionInfo.Title -match '(?i)live|🔴') { 20 } else { 0 }
                    $penaltyPaused = if ($isPlaying) { 0 } else { 20 }
                    $bonusFg = 0
                    if ($ForegroundProcessName) {
                        $appLower = $appId.ToLower()
                        if ($appLower -match [regex]::Escape($ForegroundProcessName)) { $bonusFg = 12 }
                    }
                    $score = $base + $bonusLive + $bonusFg - $penaltyPaused
                    Write-Host "SMTC -> $appId : '$titleSm' (playing:$isPlaying) score:$score"
                    $localCandidates += @{ Score = $score; Session = $sessionInfo }
                } catch {
                    Write-Host "SMTC: Error processing session: $_"
                }
            }
        }
    } catch {
        Write-Host "SMTC: Manager error: $_"
    }
    return ,$localCandidates
}

Write-Host "SMTC: ApartmentState=$([Threading.Thread]::CurrentThread.ApartmentState)"
if ([Threading.Thread]::CurrentThread.ApartmentState -ne 'STA') {
    Write-Host "SMTC: Spawning STA runspace for WinRT access"
    $iss = [System.Management.Automation.Runspaces.InitialSessionState]::CreateDefault()
    $rs = [runspacefactory]::CreateRunspace($iss)
    $rs.ApartmentState = 'STA'
    $rs.Open()
    $ps = [powershell]::Create()
    $ps.Runspace = $rs
    $ps.AddScript(${function:Get-SmtcCandidates}.ToString()) | Out-Null
    $ps.AddScript('Get-SmtcCandidates') | Out-Null
    $result = $ps.Invoke()
    $ps.Dispose()
    $rs.Dispose()
    if ($result) { $candidates += $result }
} else {
    $candidates += Get-SmtcCandidates
}

foreach ($process in $processes) {
    $processName = $process.ProcessName.ToLower()
    Write-Host "Checking process: $processName"

    # Check if this is a known media application (exact key match)
    if ($mediaApps.ContainsKey($processName)) {
        $mediaApp = $mediaApps[$processName]
        Write-Host "  -> Found media app: $processName"

        $title = $process.MainWindowTitle
        if (-not $title) { continue }

        Write-Host "    Testing title: '$title'"

        if ($title -match $mediaApp.pausedPattern -and $title -notmatch "^(New Tab|about:blank)") {
            Write-Host "    PAUSED STATE FOUND!"

            $sessionInfo = @{
                Title = "Media Paused"
                Artist = $mediaApp.displayName
                Album = $null
                AppName = $process.ProcessName
                IsPlaying = $false
                CanPlay = $true
                CanPause = $false
                CanSkipNext = $true
                CanSkipPrevious = $true
                Duration = $null
                Position = $null
                Genre = $null
            }

            # Smart scoring with paused penalty
            $base = switch ($processName) {
                "zen" { 77 }
                "brave" { 75 }
                "chrome" { 75 }
                "msedge" { 75 }
                "firefox" { 75 }
                "spotify" { 80 }
                default { 70 }
            }
            $penaltyPaused = 20
            $bonusFg = 0
            if ($ForegroundProcessName -and $processName -eq $ForegroundProcessName) { $bonusFg = 12 }
            Write-Host "  Foreground bonus: $bonusFg"
            $score = $base + $bonusFg - $penaltyPaused
            Write-Host "    Candidate score: $score (playing:$($sessionInfo.IsPlaying))"
            $candidates += @{ Score = $score; Session = $sessionInfo }
        } elseif ($title -match $mediaApp.titlePattern) {
            Write-Host "    MATCH FOUND!"

            if ($processName -eq "spotify") {
                $artist = $matches[1]
                $songTitle = $matches[2]
            } elseif ($processName -in @("chrome", "brave", "msedge", "firefox", "zen")) {
                $songTitle = $matches[1]
                $artist = "YouTube"
            } else {
                $songTitle = $matches[1]
                $artist = if ($matches[2]) { $matches[2] } else { $mediaApp.displayName }
            }

            $sessionInfo = @{
                Title = $songTitle
                Artist = $artist
                Album = $null
                AppName = $process.ProcessName
                IsPlaying = $true
                CanPlay = $true
                CanPause = $true
                CanSkipNext = $true
                CanSkipPrevious = $true
                Duration = $null
                Position = $null
                Genre = $null
            }

            # Smart scoring
            $base = switch ($processName) {
                # Prefer Spotify over non-live YouTube
                "zen" { 77 }
                "brave" { 75 }
                "chrome" { 75 }
                "msedge" { 75 }
                "firefox" { 75 }
                "spotify" { 80 }
                default { 70 }
            }
            # Stronger live bonus so live video beats music
            $bonusLive = if ($sessionInfo.Title -match '(?i)live|🔴') { 20 } else { 0 }
            $score = $base + $bonusLive
            $candidates += @{ Score = $score; Session = $sessionInfo }
        } else {
            Write-Host "    No pattern match"
        }
    }
}

if ($candidates.Count -gt 0) {
    Write-Host "BEST MATCH:"
    (
        $candidates |
        Sort-Object -Property @{
            Expression = { $_.Session.IsPlaying }
            Descending = $true
        }, @{
            Expression = { $_.Score }
            Descending = $true
        } |
        Select-Object -First 1
    ).Session | ConvertTo-Json -Compress
} else {
    Write-Host "No media sessions detected"
}
