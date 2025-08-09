import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs";
import os from "os";
import path from "path";

const execAsync = promisify(exec);

/**
 * Create a unique temp PowerShell file safely to avoid EBUSY collisions
 */
function createTempPsFile(prefix: string, contents: string): string {
  const tmp = os.tmpdir();
  for (let i = 0; i < 5; i++) {
    const name = `${prefix}_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2)}.ps1`;
    const psPath = path.join(tmp, name);
    try {
      fs.writeFileSync(psPath, contents, { encoding: "utf8", flag: "wx" });
      return psPath;
    } catch (e: any) {
      // If file exists or resource busy, try another name
      if (e && (e.code === "EEXIST" || e.code === "EBUSY")) {
        continue;
      }
      throw e;
    }
  }
  // Final attempt without exclusive flag
  const fallback = path.join(os.tmpdir(), `${prefix}_${process.pid}_${Date.now()}.ps1`);
  fs.writeFileSync(fallback, contents, { encoding: "utf8" });
  return fallback;
}

export interface MediaSession {
  title: string;
  artist?: string;
  album?: string;
  appName: string;
  appDisplayName: string;
  sourceType: "music" | "video" | "podcast" | "unknown";
  isPlaying: boolean;
  canPlay: boolean;
  canPause: boolean;
  canSkipNext: boolean;
  canSkipPrevious: boolean;
  duration?: number;
  position?: number;
  thumbnail?: string;
  channelName?: string;
  videoId?: string;
  isLive?: boolean;
  genre?: string;
  year?: number;
  playlistName?: string;
  processId?: number;
}

/**
 * PowerShell script to detect media applications using process and window title analysis
 * This is a more reliable approach than trying to use UWP APIs from PowerShell
 */
const GET_MEDIA_SESSION_SCRIPT = `
# Simplified approach - just use the main window title from Get-Process
# This avoids the complex Win32 API callback issues
function Get-ProcessWindowTitle {
    param($Process)
    try {
        # Get the main window title directly
        $title = $Process.MainWindowTitle
        if ($title -and $title.Trim() -ne "") {
            return @($title)
        }
        return @()
    }
    catch {
        return @()
    }
}

# Known media applications and their patterns
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

# Get all running processes with window titles
$processes = Get-Process | Where-Object { $_.MainWindowTitle -ne "" }

# Collect candidates and pick the best by score
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
# Helper to wait WinRT IAsyncOperation without WindowsRuntimeSystemExtensions
function Wait-AsyncOperation {
    param(
        [Parameter(Mandatory=$true)] $Operation,
        [int] $TimeoutMs = 5000,
        [int] $PollMs = 50
    )
    $elapsed = 0
    while ($Operation.Status.ToString() -eq 'Started' -and $elapsed -lt $TimeoutMs) {
        Start-Sleep -Milliseconds $PollMs
        $elapsed += $PollMs
    }
    if ($Operation.Status.ToString() -eq 'Completed') {
        return $Operation.GetResults()
    } else {
        return $null
    }
}

# Try SMTC (Global System Media Transport Controls) first
try {
    $mgrOp = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime]::RequestAsync()
    $mgr = Wait-AsyncOperation -Operation $mgrOp
    if ($mgr -ne $null) {
        $sessions = $mgr.GetSessions()
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

                if (-not $titleSm) { continue }

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
                    $appLower2 = $appId.ToLower()
                    if ($appLower2 -match [regex]::Escape($ForegroundProcessName)) { $bonusFg = 12 }
                }
                $score = $base + $bonusLive + $bonusFg - $penaltyPaused
                $candidates += @{ Score = $score; Session = $sessionInfo }
            } catch {}
        }
    }
} catch {}

foreach ($process in $processes) {
    $processName = $process.ProcessName.ToLower()
    $title = $process.MainWindowTitle
    
    # Determine paused status from configured pausedPattern and compute foreground bonus
    $appConf = $mediaApps[$processName]
    $isPausedTitle = $false
    if ($appConf -and $appConf.pausedPattern) {
        try { if ($title -match $appConf.pausedPattern) { $isPausedTitle = $true } } catch {}
    }
    $fgBonus = 0
    if ($ForegroundProcessName -and ($process.ProcessName.ToLower() -eq $ForegroundProcessName)) { $fgBonus = 12 }
    
    # Check Spotify
    if ($processName -eq "spotify" -and $title -match '^(.+) - (.+)$') {
        $artist = $matches[1]
        $songTitle = $matches[2]
        
        $isPlaying = (-not $isPausedTitle)
        $sessionInfo = @{
            Title = $songTitle
            Artist = $artist
            Album = $null
            AppName = $process.ProcessName
            IsPlaying = $isPlaying
            CanPlay = $true
            CanPause = $true
            CanSkipNext = $true
            CanSkipPrevious = $true
            Duration = $null
            Position = $null
            Genre = $null
        }
        
        # Score: base 80 for Spotify (music)
        $score = 80
        if ($sessionInfo.Title -match '(?i)live|🔴') { $score += 5 }
        $score += $fgBonus
        if (-not $isPlaying) { $score -= 20 }
        $candidates += @{ Score = $score; Session = $sessionInfo }
    }
    
    # Check Brave/YouTube
    if ($processName -eq "brave" -and $title -match '^(.+) - YouTube - Brave$') {
        $videoTitle = $matches[1]
        
        $isPlaying = (-not $isPausedTitle)
        $sessionInfo = @{
            Title = $videoTitle
            Artist = "YouTube"
            Album = $null
            AppName = $process.ProcessName
            IsPlaying = $isPlaying
            CanPlay = $true
            CanPause = $true
            CanSkipNext = $true
            CanSkipPrevious = $true
            Duration = $null
            Position = $null
            Genre = $null
        }
        
        # Score: base 90 for YouTube video in Brave
        $score = 90
        if ($sessionInfo.Title -match '(?i)live|🔴') { $score += 5 }
        $score += $fgBonus
        if (-not $isPlaying) { $score -= 20 }
        $candidates += @{ Score = $score; Session = $sessionInfo }
    }
    
    # Check Chrome/YouTube
    if ($processName -eq "chrome" -and $title -match '^(.+) - YouTube - Google Chrome$') {
        $videoTitle = $matches[1]
        
        $isPlaying = (-not $isPausedTitle)
        $sessionInfo = @{
            Title = $videoTitle
            Artist = "YouTube"
            Album = $null
            AppName = $process.ProcessName
            IsPlaying = $isPlaying
            CanPlay = $true
            CanPause = $true
            CanSkipNext = $true
            CanSkipPrevious = $true
            Duration = $null
            Position = $null
            Genre = $null
        }
        
        # Score: base 90 for YouTube video in Chrome
        $score = 90
        if ($sessionInfo.Title -match '(?i)live|🔴') { $score += 5 }
        $score += $fgBonus
        if (-not $isPlaying) { $score -= 20 }
        $candidates += @{ Score = $score; Session = $sessionInfo }
    }
    
    # Check Microsoft Edge/YouTube
    if ($processName -eq "msedge" -and $title -match '^(.+) - YouTube - Microsoft.*Edge$') {
        $videoTitle = $matches[1]
        
        $isPlaying = (-not $isPausedTitle)
        $sessionInfo = @{
            Title = $videoTitle
            Artist = "YouTube"
            Album = $null
            AppName = $process.ProcessName
            IsPlaying = $isPlaying
            CanPlay = $true
            CanPause = $true
            CanSkipNext = $true
            CanSkipPrevious = $true
            Duration = $null
            Position = $null
            Genre = $null
        }
        
        # Score: base 90 for YouTube video in Edge
        $score = 90
        if ($sessionInfo.Title -match '(?i)live|🔴') { $score += 5 }
        $score += $fgBonus
        if (-not $isPlaying) { $score -= 20 }
        $candidates += @{ Score = $score; Session = $sessionInfo }
    }
    
    # Check Firefox/YouTube
    if ($processName -eq "firefox" -and $title -match '^(.+) - YouTube - Mozilla Firefox$') {
        $videoTitle = $matches[1]
        
        $isPlaying = (-not $isPausedTitle)
        $sessionInfo = @{
            Title = $videoTitle
            Artist = "YouTube"
            Album = $null
            AppName = $process.ProcessName
            IsPlaying = $isPlaying
            CanPlay = $true
            CanPause = $true
            CanSkipNext = $true
            CanSkipPrevious = $true
            Duration = $null
            Position = $null
            Genre = $null
        }
        
        # Score: base 75 for YouTube video in Firefox (non-live)
        $score = 75
        if ($sessionInfo.Title -match '(?i)live|🔴') { $score += 20 }
        $score += $fgBonus
        if (-not $isPlaying) { $score -= 20 }
        $candidates += @{ Score = $score; Session = $sessionInfo }
    }
    
    # Check Zen Browser/YouTube (supports hyphen/en dash/em dash, optional spaces, optional " Browser")
    if ($processName -eq "zen" -and $title -match '^(.+) - YouTube \\s*[\\u2014\\u2013\-]\\s*Zen( Browser)?$') {
        $videoTitle = $matches[1]
        
        $isPlaying = (-not $isPausedTitle)
        $sessionInfo = @{
            Title = $videoTitle
            Artist = "YouTube"
            Album = $null
            AppName = $process.ProcessName
            IsPlaying = $isPlaying
            CanPlay = $true
            CanPause = $true
            CanSkipNext = $true
            CanSkipPrevious = $true
            Duration = $null
            Position = $null
            Genre = $null
        }
        
        # Score: base 77 for YouTube video in Zen (non-live)
        $score = 77
        if ($sessionInfo.Title -match '(?i)live|🔴') { $score += 20 }
        $score += $fgBonus
        if (-not $isPlaying) { $score -= 20 }
        $candidates += @{ Score = $score; Session = $sessionInfo }
    }
}

# If we found candidates, output the best one
if ($candidates.Count -gt 0) {
    $best = $candidates | Sort-Object -Property Score -Descending | Select-Object -First 1
    $best.Session | ConvertTo-Json -Compress
    exit
}

# If no media found, return empty
Write-Output ""
`;

/**
 * Get the current active media session
 */
export async function getCurrentMediaSession(): Promise<MediaSession | null> {
  let psPath: string | null = null;
  try {
    // Write script to a temporary .ps1 file to avoid command-line length limits
    const psScript = GET_MEDIA_SESSION_SCRIPT;
    psPath = createTempPsFile("raycast_media_detect", psScript);

    const { stdout, stderr } = await execAsync(
      `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${psPath}"`
    );

    if (stdout && stdout.trim()) {
      const sessionData = JSON.parse(stdout.trim());
      
      const mediaInfo = parseMediaInfo(sessionData.Title, sessionData.Artist, sessionData.AppName);
      
      return {
        title: mediaInfo.title,
        artist: mediaInfo.artist,
        album: sessionData.Album,
        appName: sessionData.AppName,
        appDisplayName: getAppDisplayName(sessionData.AppName),
        sourceType: determineSourceType(sessionData.AppName, sessionData.Title, sessionData.Artist),
        isPlaying: sessionData.IsPlaying,
        canPlay: sessionData.CanPlay,
        canPause: sessionData.CanPause,
        canSkipNext: sessionData.CanSkipNext,
        canSkipPrevious: sessionData.CanSkipPrevious,
        duration: sessionData.Duration,
        position: sessionData.Position,
        thumbnail: undefined,
        channelName: mediaInfo.channelName,
        videoId: mediaInfo.videoId,
        isLive: mediaInfo.isLive,
        genre: sessionData.Genre,
        playlistName: mediaInfo.playlistName,
        processId: undefined,
      };
    }
  } catch (error) {
    // Print minimal diagnostics to help debugging when running inside Raycast
    console.error("Media session detection failed:", error);
  } finally {
    if (psPath) {
      try { fs.unlinkSync(psPath); } catch {}
    }
  }
  
  return null;
}

/**
 * Control volume using basic Windows system volume controls
 */
export async function controlAppVolume(action: "up" | "down" | "mute"): Promise<boolean> {
  let psPath: string | null = null;
  try {
    const ps = `param([string]$Action)
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class KbdSender {
  [DllImport("user32.dll", SetLastError=true)]
  public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
}
public static class AppCommandSender {
  public const int WM_APPCOMMAND = 0x0319;
  public const int APPCOMMAND_MEDIA_PLAY = 46; // 0x2E
  [DllImport("user32.dll", CharSet=CharSet.Unicode)]
  public static extern IntPtr SendMessageW(IntPtr hWnd, int Msg, IntPtr wParam, IntPtr lParam);
}
"@
$vk = 0xAF # VOL_UP
switch ($Action) {
  'up' { $vk = 0xAF }
  'down' { $vk = 0xAE }
  'mute' { $vk = 0xAD }
}
try {
  [KbdSender]::keybd_event([byte]$vk, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 10
  [KbdSender]::keybd_event([byte]$vk, 0, 2, [UIntPtr]::Zero)
  'OK'
} catch { 'ERR' }
`;
    psPath = createTempPsFile("raycast_volume_keys", ps);
    const { stdout } = await execAsync(`powershell -STA -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${psPath}" -Action ${action}`);
    const ok = stdout.trim().includes("OK");
    if (ok) console.log(`Volume ${action} successful`);
    return ok;
  } catch (error) {
    console.error(`Error in controlAppVolume:`, error);
    return false;
  } finally {
    if (psPath) { try { fs.unlinkSync(psPath); } catch {} }
  }
}

/**
 * Control media playback using basic Windows media keys
 */
export async function controlMedia(action: "play" | "pause" | "next" | "previous" | "toggle"): Promise<boolean> {
  try {
    const ps = `
param([string]$Action)

function Wait-AsyncOperation {
  param([Parameter(Mandatory=$true)] $Operation, [int] $TimeoutMs = 4000, [int] $PollMs = 50)
  $elapsed = 0
  while ($Operation.Status.ToString() -eq 'Started' -and $elapsed -lt $TimeoutMs) {
    Start-Sleep -Milliseconds $PollMs
    $elapsed += $PollMs
  }
  if ($Operation.Status.ToString() -eq 'Completed') { return $Operation.GetResults() } else { return $false }
}

$usedSmTc = $false
# Determine foreground process name to better target session
Add-Type -Namespace Win32 -Name Native -MemberDefinition @"
    [System.Runtime.InteropServices.DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();
    [System.Runtime.InteropServices.DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr hWnd, out uint lpdwProcessId);
"@
$hWnd = [Win32.Native]::GetForegroundWindow()
$fgPid = 0
[Win32.Native]::GetWindowThreadProcessId($hWnd, [ref]$fgPid) | Out-Null
$ForegroundProcessName = $null
if ($fgPid -ne 0) {
  try { $ForegroundProcessName = ([System.Diagnostics.Process]::GetProcessById([int]$fgPid)).ProcessName.ToLower() } catch {}
}
try {
  $mgrOp = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime]::RequestAsync()
  $mgr = Wait-AsyncOperation -Operation $mgrOp
  if ($mgr) {
    $target = $null
    try {
      $sessions = $mgr.GetSessions()
      if ($sessions) {
        # Prefer sessions that match the foreground app name within AUMID (any status)
        if ($ForegroundProcessName) {
          foreach ($sess in $sessions) {
            try {
              $info = $sess.GetPlaybackInfo()
              $status = $info.PlaybackStatus
              $appId = ($sess.SourceAppUserModelId | Out-String).Trim().ToLower()
              if ($appId -match [regex]::Escape($ForegroundProcessName)) {
                $target = $sess; break
              }
            } catch {}
          }
        }
        # Otherwise any playing session
        if ($target -eq $null) {
          foreach ($sess in $sessions) {
            try { if ($sess.GetPlaybackInfo().PlaybackStatus -eq [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionPlaybackStatus]::Playing) { $target = $sess; break } } catch {}
          }
        }
      }
    } catch {}
    if ($target -eq $null) { $target = $mgr.GetCurrentSession() }
    if ($target -ne $null) {
      $usedSmTc = $true
      switch ($Action) {
        'play'     { [void](Wait-AsyncOperation -Operation $target.TryPlayAsync()) }
        'pause'    { [void](Wait-AsyncOperation -Operation $target.TryPauseAsync()) }
        'toggle'   { [void](Wait-AsyncOperation -Operation $target.TryTogglePlayPauseAsync()) }
        'next'     { [void](Wait-AsyncOperation -Operation $target.TrySkipNextAsync()) }
        'previous' { [void](Wait-AsyncOperation -Operation $target.TrySkipPreviousAsync()) }
      }
    } elseif ($sessions) {
      # No specific target; broadcast to sessions for play/pause cases
      if ($Action -eq 'play') {
        foreach ($sess in $sessions) {
          try { [void](Wait-AsyncOperation -Operation $sess.TryPlayAsync()); $usedSmTc = $true } catch {}
        }
      } elseif ($Action -eq 'pause') {
        foreach ($sess in $sessions) {
          try {
            $info = $sess.GetPlaybackInfo()
            if ($info.PlaybackStatus -eq [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionPlaybackStatus]::Playing) {
              [void](Wait-AsyncOperation -Operation $sess.TryPauseAsync()); $usedSmTc = $true
            }
          } catch {}
        }
      }
    }
  }
} catch {}

# Also synthesize system media keys using user32.keybd_event to ensure action is applied
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class KbdSender {
  [DllImport("user32.dll", SetLastError=true)]
  public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
}
"@
$vk = 0xB3 # PLAY/PAUSE
switch ($Action) {
  'play' { $vk = 0xB3 }
  'pause' { $vk = 0xB3 }
  'toggle' { $vk = 0xB3 }
  'next' { $vk = 0xB0 }
  'previous' { $vk = 0xB1 }
}
try {
  [KbdSender]::keybd_event([byte]$vk, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 10
  [KbdSender]::keybd_event([byte]$vk, 0, 2, [UIntPtr]::Zero) # KEYEVENTF_KEYUP = 2
} catch {}

# If we didn't use SMTC and the requested action is explicit 'play',
# also broadcast WM_APPCOMMAND MEDIA_PLAY to help resume certain apps (e.g., Spotify)
if ((-not $usedSmTc) -and ($Action -eq 'play')) {
  try {
    $HWND_BROADCAST = [IntPtr]65535
    $cmd = [IntPtr]([AppCommandSender]::APPCOMMAND_MEDIA_PLAY -shl 16)
    [void][AppCommandSender]::SendMessageW($HWND_BROADCAST, [AppCommandSender]::WM_APPCOMMAND, [IntPtr]::Zero, $cmd)
  } catch {}
}

if ($usedSmTc) { $pathLabel = "SMTC+VK" } else { $pathLabel = "VK" }
Write-Output ("OK " + $pathLabel)
`;

    const psPath = path.join(os.tmpdir(), "raycast_media_control.ps1");
    fs.writeFileSync(psPath, ps, { encoding: "utf8" });

    const { stdout } = await execAsync(`powershell -STA -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${psPath}" -Action ${action}`);
    const out = stdout.trim();
    const ok = out.includes("OK");
    if (ok) console.log(`Media ${action} successful (${out})`);
    return ok;
  } catch (error) {
    console.error(`Error in controlMedia:`, error);
    return false;
  }
}

/**
 * Get volume level (0-100)
 */
export async function getVolume(): Promise<number | null> {
  let psPath: string | null = null;
  try {
    const script = `
try {
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class VolumeHelper {
    [DllImport("winmm.dll")]
    public static extern int waveOutGetVolume(IntPtr hwo, out uint dwVolume);
    public static int GetVolume() {
        uint volume = 0;
        int result = waveOutGetVolume(IntPtr.Zero, out volume);
        if (result == 0) {
            return (int)((volume & 0x0000ffff) * 100 / 0xffff);
        }
        return 50;
    }
}
"@
  [VolumeHelper]::GetVolume() | Out-Host
} catch { "50" | Out-Host }
`;
    psPath = createTempPsFile("raycast_get_volume", script);
    const { stdout } = await execAsync(`powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${psPath}"`);
    const volume = parseInt(stdout.trim());
    return isNaN(volume) ? 50 : Math.max(0, Math.min(100, volume));
  } catch (error) {
    console.error("Error getting volume:", error);
    return 50; // Default fallback
  } finally {
    if (psPath) { try { fs.unlinkSync(psPath); } catch {} }
  }
}

/**
 * Set system volume (0-100)
 */
export async function setVolume(volume: number): Promise<boolean> {
  let psPath: string | null = null;
  try {
    const clampedVolume = Math.max(0, Math.min(100, volume));
    
    const script = `
param([int]$Target)
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class VolumeControl {
    [DllImport("winmm.dll")]
    public static extern int waveOutSetVolume(IntPtr hwo, uint dwVolume);
    public static void SetVolume(int volume) {
        uint vol = (uint)((volume * 0xFFFF) / 100);
        uint stereoVol = (vol << 16) | vol;
        waveOutSetVolume(IntPtr.Zero, stereoVol);
    }
}
"@
[VolumeControl]::SetVolume($Target)
Write-Output "Success"
`;
    psPath = createTempPsFile("raycast_set_volume", script);
    const { stdout } = await execAsync(`powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${psPath}" -Target ${clampedVolume}`);
    return stdout.trim().includes("Success");
  } catch (error) {
    console.error(`Error setting volume to ${volume}:`, error);
    return false;
  } finally {
    if (psPath) { try { fs.unlinkSync(psPath); } catch {} }
  }
}

/**
 * Convert app model ID to display name
 */
export function getAppDisplayName(appModelId: string): string {
  if (!appModelId) return "Unknown App";
  
  const appMappings: { [key: string]: string } = {
    // Music Apps
    "Spotify.exe": "Spotify",
    "iTunes.exe": "iTunes",
    "foobar2000.exe": "foobar2000",
    "winamp.exe": "Winamp",
    "AIMP.exe": "AIMP",
    "MusicBee.exe": "MusicBee",
    "AppleMusic.exe": "Apple Music",
    "AmazonMusic.exe": "Amazon Music",
    "Deezer.exe": "Deezer",
    "Tidal.exe": "Tidal",
    "YouTubeMusic.exe": "YouTube Music",
    "SoundCloud.exe": "SoundCloud",
    
    // Browsers
    "chrome.exe": "Chrome",
    "firefox.exe": "Firefox",
    "msedge.exe": "Edge",
    "brave.exe": "Brave",
    "opera.exe": "Opera",
    "vivaldi.exe": "Vivaldi",
    
    // Video Players
    "vlc.exe": "VLC Media Player",
    "wmplayer.exe": "Windows Media Player",
    "mpc-hc64.exe": "MPC-HC",
    "mpc-be64.exe": "MPC-BE",
    "PotPlayerMini64.exe": "PotPlayer",
    "mpv.exe": "mpv",
    
    // Streaming Apps
    "Netflix.exe": "Netflix",
    "DisneyPlus.exe": "Disney+",
    "PrimeVideo.exe": "Prime Video",
    "Hulu.exe": "Hulu",
    "Twitch.exe": "Twitch",
    "Discord.exe": "Discord",
    
    // Gaming/Communication
    "Steam.exe": "Steam",
    "TeamSpeak3.exe": "TeamSpeak",
    "Skype.exe": "Skype",
    "Zoom.exe": "Zoom",
  };
  
  // Handle Windows Store apps
  if (appModelId.includes("!")) {
    const parts = appModelId.split("!");
    const packageName = parts[0];
    
    const storeAppMappings: { [key: string]: string } = {
      "SpotifyAB.SpotifyMusic": "Spotify",
      "Microsoft.ZuneMusic": "Groove Music",
      "Microsoft.ZuneVideo": "Movies & TV",
      "Netflix.Netflix": "Netflix",
      "5319275A.WhatsAppDesktop": "WhatsApp",
      "Microsoft.SkypeApp": "Skype",
      "DiscordInc.Discord": "Discord",
      "TelegramMessengerLLP.TelegramDesktop": "Telegram",
      "AppleInc.iTunes": "iTunes",
      "Microsoft.MSPaint": "Paint",
      "Microsoft.WindowsCalculator": "Calculator",
    };
    
    for (const [key, value] of Object.entries(storeAppMappings)) {
      if (packageName.includes(key)) {
        return value;
      }
    }
  }
  
  // Extract executable name from app model ID
  const execName = appModelId.split("\\").pop() || appModelId.split("!").pop() || appModelId;
  
  return appMappings[execName] || execName.replace(".exe", "").replace(/[._-]/g, " ");
}

/**
 * Parse media information to extract YouTube/video specific details
 */
export function parseMediaInfo(title: string, artist: string, appName: string): {
  title: string;
  artist: string;
  channelName?: string;
  videoId?: string;
  isLive?: boolean;
  playlistName?: string;
} {
  const isYouTube = appName.toLowerCase().includes("chrome") || 
                   appName.toLowerCase().includes("firefox") || 
                   appName.toLowerCase().includes("edge") || 
                   appName.toLowerCase().includes("brave") ||
                   appName.toLowerCase().includes("youtube");
  
  if (isYouTube && title && artist) {
    // YouTube format: "Video Title - Channel Name"
    // or "Video Title" with artist as channel
    let videoTitle = title;
    let channelName: string | undefined = artist || undefined;
    
    // Check for live indicators
    const isLive = title.toLowerCase().includes("live") || 
                   title.toLowerCase().includes("🔴") ||
                   artist.toLowerCase().includes("live");
    
    // Extract video ID from title if present (sometimes embedded)
    let videoId: string | undefined;
    const videoIdMatch = title.match(/\[([a-zA-Z0-9_-]{11})\]/);
    if (videoIdMatch) {
      videoId = videoIdMatch[1];
      videoTitle = title.replace(videoIdMatch[0], "").trim();
    }
    
    // Handle playlist information
    let playlistName: string | undefined;
    if (title.includes("Playlist:") || artist.includes("Playlist:")) {
      const playlistMatch = (title + " " + artist).match(/Playlist:\s*([^-•]+)/);
      if (playlistMatch) {
        playlistName = playlistMatch[1].trim();
      }
    }
    
    // If the artist is literally 'YouTube', we don't have channel metadata from the title
    if (channelName && channelName.trim().toLowerCase() === "youtube") {
      channelName = undefined;
    }
    
    return {
      title: videoTitle || "Unknown Video",
      artist: channelName || "Unknown Channel",
      channelName: channelName,
      videoId,
      isLive,
      playlistName,
    };
  }
  
  return {
    title: title || "Unknown Title",
    artist: artist || "Unknown Artist",
  };
}

/**
 * Determine the source type based on app and content
 */
export function determineSourceType(appName: string, title: string, artist: string): "music" | "video" | "podcast" | "unknown" {
  const lowerAppName = appName.toLowerCase();
  const lowerTitle = (title || "").toLowerCase();
  const lowerArtist = (artist || "").toLowerCase();

  // Treat browser + YouTube patterns as video
  const isBrowser = /chrome|brave|edge|firefox|zen|vivaldi|opera/.test(lowerAppName);
  const looksLikeYouTube = lowerTitle.includes(" - youtube - ") || lowerArtist === "youtube" || /\byoutube\b/.test(lowerTitle);

  // Video indicators
  if (looksLikeYouTube ||
      lowerAppName.includes("youtube") ||
      lowerAppName.includes("netflix") ||
      lowerAppName.includes("disney") ||
      lowerAppName.includes("prime") ||
      lowerAppName.includes("hulu") ||
      lowerAppName.includes("vlc") ||
      (isBrowser && looksLikeYouTube) ||
      lowerTitle.includes("watch") ||
      lowerTitle.includes("video")) {
    return "video";
  }
  
  // Podcast indicators
  if (lowerTitle.includes("podcast") ||
      lowerArtist.includes("podcast") ||
      lowerTitle.includes("episode") ||
      lowerAppName.includes("podcast")) {
    return "podcast";
  }
  
  // Music indicators
  if (lowerAppName.includes("spotify") ||
      lowerAppName.includes("apple music") ||
      lowerAppName.includes("itunes") ||
      lowerAppName.includes("amazon music") ||
      lowerAppName.includes("deezer") ||
      lowerAppName.includes("tidal") ||
      lowerAppName.includes("soundcloud") ||
      lowerAppName.includes("foobar") ||
      lowerAppName.includes("winamp") ||
      lowerAppName.includes("musicbee")) {
    return "music";
  }
  
  return "unknown";
}
