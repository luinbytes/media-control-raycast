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
            $score = $base - $penaltyPaused
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
