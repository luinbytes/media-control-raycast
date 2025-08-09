import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs";
import os from "os";
import path from "path";

const execAsync = promisify(exec);

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
    
    # Check Spotify
    if ($processName -eq "spotify" -and $title -match '^(.+) - (.+)$') {
        $artist = $matches[1]
        $songTitle = $matches[2]
        
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
        
        # Score: base 80 for Spotify (music)
        $score = 80
        if ($sessionInfo.Title -match '(?i)live|🔴') { $score += 5 }
        $candidates += @{ Score = $score; Session = $sessionInfo }
    }
    
    # Check Brave/YouTube
    if ($processName -eq "brave" -and $title -match '^(.+) - YouTube - Brave$') {
        $videoTitle = $matches[1]
        
        $sessionInfo = @{
            Title = $videoTitle
            Artist = "YouTube"
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
        
        # Score: base 90 for YouTube video in Brave
        $score = 90
        if ($sessionInfo.Title -match '(?i)live|🔴') { $score += 5 }
        $candidates += @{ Score = $score; Session = $sessionInfo }
    }
    
    # Check Chrome/YouTube
    if ($processName -eq "chrome" -and $title -match '^(.+) - YouTube - Google Chrome$') {
        $videoTitle = $matches[1]
        
        $sessionInfo = @{
            Title = $videoTitle
            Artist = "YouTube"
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
        
        # Score: base 90 for YouTube video in Chrome
        $score = 90
        if ($sessionInfo.Title -match '(?i)live|🔴') { $score += 5 }
        $candidates += @{ Score = $score; Session = $sessionInfo }
    }
    
    # Check Microsoft Edge/YouTube
    if ($processName -eq "msedge" -and $title -match '^(.+) - YouTube - Microsoft.*Edge$') {
        $videoTitle = $matches[1]
        
        $sessionInfo = @{
            Title = $videoTitle
            Artist = "YouTube"
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
        
        # Score: base 90 for YouTube video in Edge
        $score = 90
        if ($sessionInfo.Title -match '(?i)live|🔴') { $score += 5 }
        $candidates += @{ Score = $score; Session = $sessionInfo }
    }
    
    # Check Firefox/YouTube
    if ($processName -eq "firefox" -and $title -match '^(.+) - YouTube - Mozilla Firefox$') {
        $videoTitle = $matches[1]
        
        $sessionInfo = @{
            Title = $videoTitle
            Artist = "YouTube"
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
        
        # Score: base 75 for YouTube video in Firefox (non-live)
        $score = 75
        if ($sessionInfo.Title -match '(?i)live|🔴') { $score += 20 }
        $candidates += @{ Score = $score; Session = $sessionInfo }
    }
    
    # Check Zen Browser/YouTube (supports hyphen/en dash/em dash, optional spaces, optional " Browser")
    if ($processName -eq "zen" -and $title -match '^(.+) - YouTube \\s*[\\u2014\\u2013\-]\\s*Zen( Browser)?$') {
        $videoTitle = $matches[1]
        
        $sessionInfo = @{
            Title = $videoTitle
            Artist = "YouTube"
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
        
        # Score: base 77 for YouTube video in Zen (non-live)
        $score = 77
        if ($sessionInfo.Title -match '(?i)live|🔴') { $score += 20 }
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
  try {
    // Write script to a temporary .ps1 file to avoid command-line length limits
    const psScript = GET_MEDIA_SESSION_SCRIPT;
    const psPath = path.join(os.tmpdir(), "raycast_media_detect.ps1");
    fs.writeFileSync(psPath, psScript, { encoding: "utf8" });

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
  }
  
  return null;
}

/**
 * Control volume using basic Windows system volume controls
 */
export async function controlAppVolume(action: "up" | "down" | "mute"): Promise<boolean> {
  try {
    let script = "";
    
    switch (action) {
      case "up":
        script = "(New-Object -comObject WScript.Shell).SendKeys([char]175)";
        break;
      case "down":
        script = "(New-Object -comObject WScript.Shell).SendKeys([char]174)";
        break;
      case "mute":
        script = "(New-Object -comObject WScript.Shell).SendKeys([char]173)";
        break;
    }
    
    await execAsync(`powershell -Command "${script}"`);
    console.log(`Volume ${action} successful`);
    return true;
  } catch (error) {
    console.error(`Error in controlAppVolume:`, error);
    return false;
  }
}

/**
 * Control media playback using basic Windows media keys
 */
export async function controlMedia(action: "play" | "pause" | "next" | "previous" | "toggle"): Promise<boolean> {
  try {
    let script = "";
    
    switch (action) {
      case "play":
        script = "(New-Object -comObject WScript.Shell).SendKeys([char]179)";
        break;
      case "pause":
        script = "(New-Object -comObject WScript.Shell).SendKeys([char]179)";
        break;
      case "toggle":
        script = "(New-Object -comObject WScript.Shell).SendKeys([char]179)";
        break;
      case "next":
        script = "(New-Object -comObject WScript.Shell).SendKeys([char]176)";
        break;
      case "previous":
        script = "(New-Object -comObject WScript.Shell).SendKeys([char]177)";
        break;
    }
    
    await execAsync(`powershell -Command "${script}"`);
    console.log(`Media ${action} successful`);
    return true;
  } catch (error) {
    console.error(`Error in controlMedia:`, error);
    return false;
  }
}

/**
 * Get volume level (0-100)
 */
export async function getVolume(): Promise<number | null> {
  try {
    const script = `
Add-Type -AssemblyName System.Windows.Forms
try {
    # Try to get volume using Windows API
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
        return 50; // Default fallback
    }
}
"@
    [VolumeHelper]::GetVolume()
} catch {
    Write-Output "50"
}
    `;
    
    const { stdout } = await execAsync(`powershell -Command "${script}"`);
    const volume = parseInt(stdout.trim());
    return isNaN(volume) ? 50 : Math.max(0, Math.min(100, volume));
  } catch (error) {
    console.error("Error getting volume:", error);
    return 50; // Default fallback
  }
}

/**
 * Set system volume (0-100)
 */
export async function setVolume(volume: number): Promise<boolean> {
  try {
    const clampedVolume = Math.max(0, Math.min(100, volume));
    
    const script = `
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
[VolumeControl]::SetVolume(${clampedVolume})
Write-Output "Success"
    `;
    
    const { stdout } = await execAsync(`powershell -Command "${script}"`);
    return stdout.trim().includes("Success");
  } catch (error) {
    console.error(`Error setting volume to ${volume}:`, error);
    return false;
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
    let channelName = artist;
    
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
  
  // Video indicators
  if (lowerAppName.includes("youtube") || 
      lowerAppName.includes("netflix") || 
      lowerAppName.includes("disney") ||
      lowerAppName.includes("prime") ||
      lowerAppName.includes("hulu") ||
      lowerAppName.includes("vlc") ||
      lowerAppName.includes("media player") ||
      lowerTitle.includes("video") ||
      lowerTitle.includes("movie") ||
      lowerTitle.includes("episode")) {
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
