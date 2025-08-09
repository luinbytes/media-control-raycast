import React, { useState, useEffect, useCallback } from "react";
import {
  List,
  ActionPanel,
  Action,
  Icon,
  Color,
  Toast,
  showToast,
  getPreferenceValues,
} from "@raycast/api";
import {
  getCurrentMediaSession,
  controlMedia,
  controlAppVolume,
  getVolume,
  setVolume,
  MediaSession,
} from "./utils/mediaUtils";

interface Preferences {
  refreshInterval: string;
}

export default function MediaControl() {
  const [mediaSession, setMediaSession] = useState<MediaSession | null>(null);
  const [volume, setVolumeState] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());
  
  const preferences = getPreferenceValues<Preferences>();
  const refreshInterval = parseInt(preferences.refreshInterval) || 2000;

  const refreshMediaInfo = useCallback(async () => {
    try {
      const [session, currentVolume] = await Promise.all([
        getCurrentMediaSession(),
        getVolume(),
      ]);
      
      setMediaSession(session);
      setVolumeState(currentVolume);
      setLastRefresh(new Date());
    } catch (error) {
      console.error("Error refreshing media info:", error);
      await showToast({
        style: Toast.Style.Failure,
        title: "Failed to refresh media info",
        message: String(error),
      });
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshMediaInfo();
    
    const interval = setInterval(refreshMediaInfo, refreshInterval);
    return () => clearInterval(interval);
  }, [refreshInterval]);

  const handleMediaControl = async (action: "play" | "pause" | "next" | "previous" | "toggle") => {
    setIsLoading(true);
    
    try {
      const success = await controlMedia(action);
      
      if (success) {
        await showToast({
          style: Toast.Style.Success,
          title: `Media ${action}`,
          message: `Successfully ${action}ed media`,
        });
      } else {
        await showToast({
          style: Toast.Style.Failure,
          title: "Media Control Failed",
          message: `Could not ${action} media`,
        });
      }
    } catch (error) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Error",
        message: String(error),
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleVolumeControl = async (action: "up" | "down" | "mute") => {
    setIsLoading(true);
    
    try {
      const success = await controlAppVolume(action);
      
      if (success) {
        await showToast({
          style: Toast.Style.Success,
          title: "Volume Control",
          message: `Volume ${action === "up" ? "increased" : action === "down" ? "decreased" : "muted/unmuted"}`,
        });
        // Refresh to get updated info
        await refreshMediaInfo();
      } else {
        await showToast({
          style: Toast.Style.Failure,
          title: "Volume Control Failed",
          message: "Could not control app volume",
        });
      }
    } catch (error) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Error",
        message: String(error),
      });
    } finally {
      setIsLoading(false);
    }
  };

  const getPlaybackIcon = () => {
    if (!mediaSession) return Icon.QuestionMark;
    return mediaSession.isPlaying ? Icon.Pause : Icon.Play;
  };

  const getPlaybackColor = () => {
    if (!mediaSession) return Color.SecondaryText;
    return mediaSession.isPlaying ? Color.Green : Color.Orange;
  };

  const formatLastRefresh = () => {
    const now = new Date();
    const diff = Math.floor((now.getTime() - lastRefresh.getTime()) / 1000);
    
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    return `${Math.floor(diff / 3600)}h ago`;
  };

  const getMediaSubtitle = (session: MediaSession) => {
    if (session.channelName && session.sourceType === "video") {
      return `${session.channelName} • ${session.appDisplayName}`;
    }
    return `${session.artist} • ${session.appDisplayName}`;
  };

  const getMediaAccessories = (session: MediaSession) => {
    const accessories: Array<{ text?: string; icon?: { source: any; tintColor: any } }> = [];
    
    if (session.album && session.sourceType === "music") {
      accessories.push({ text: session.album });
    }
    
    if (session.isLive) {
      accessories.push({ text: "🔴 LIVE" });
    }
    
    accessories.push({
      icon: { source: getPlaybackIcon(), tintColor: getPlaybackColor() },
      text: session.isPlaying ? "Playing" : "Paused"
    });
    
    return accessories;
  };

  const getMediaIcon = (sourceType: string) => {
    switch (sourceType) {
      case "video":
        return Icon.Video;
      case "podcast":
        return Icon.Microphone;
      case "music":
        return Icon.Music;
      default:
        return Icon.SpeakerUp;
    }
  };

  const getMediaIconColor = (sourceType: string) => {
    switch (sourceType) {
      case "video":
        return Color.Red;
      case "podcast":
        return Color.Orange;
      case "music":
        return Color.Blue;
      default:
        return Color.SecondaryText;
    }
  };

  const formatDuration = (seconds?: number) => {
    if (!seconds || seconds <= 0) return "";
    
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    
    if (hours > 0) {
      return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${minutes}:${secs.toString().padStart(2, '0')}`;
  };

  const formatProgress = (position?: number, duration?: number) => {
    if (!position && !duration) return "No progress info";
    
    const posStr = formatDuration(position);
    const durStr = formatDuration(duration);
    
    if (position && duration) {
      const percentage = Math.round((position / duration) * 100);
      return `${posStr} / ${durStr} (${percentage}%)`;
    } else if (position) {
      return `${posStr} elapsed`;
    } else if (duration) {
      return `${durStr} total`;
    }
    
    return "Unknown progress";
  };

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Search media controls...">
      {!mediaSession ? (
        <List.Item
          title="No Active Media Session"
          subtitle="Start playing media in any app to control it here"
          icon={{ source: Icon.SpeakerOff, tintColor: Color.SecondaryText }}
          actions={
            <ActionPanel>
              <Action
                title="Refresh"
                icon={Icon.ArrowClockwise}
                onAction={refreshMediaInfo}
                shortcut={{ modifiers: ["cmd"], key: "r" }}
              />
            </ActionPanel>
          }
        />
      ) : (
        <>
          {/* Current Track Info */}
          <List.Item
            title={mediaSession.title}
            subtitle={getMediaSubtitle(mediaSession)}
            accessories={getMediaAccessories(mediaSession)}
            icon={{ source: getMediaIcon(mediaSession.sourceType), tintColor: getMediaIconColor(mediaSession.sourceType) }}
            actions={
              <ActionPanel>
                <Action
                  title={mediaSession.isPlaying ? "Pause" : "Play"}
                  icon={mediaSession.isPlaying ? Icon.Pause : Icon.Play}
                  onAction={() => handleMediaControl("toggle")}
                  shortcut={{ modifiers: ["cmd"], key: "space" }}
                />
                <Action
                  title="Refresh"
                  icon={Icon.ArrowClockwise}
                  onAction={refreshMediaInfo}
                  shortcut={{ modifiers: ["cmd"], key: "r" }}
                />
              </ActionPanel>
            }
          />

          {/* Detailed Media Information */}
          <List.Section title="Media Details">
            <List.Item
              title="Source"
              subtitle={`${mediaSession.appDisplayName} • ${mediaSession.sourceType.charAt(0).toUpperCase() + mediaSession.sourceType.slice(1)}`}
              accessories={[
                { text: mediaSession.isLive ? "🔴 LIVE" : "" }
              ]}
              icon={{ source: Icon.Desktop, tintColor: Color.SecondaryText }}
            />
            
            {mediaSession.channelName && (
              <List.Item
                title="Channel"
                subtitle={mediaSession.channelName}
                icon={{ source: Icon.Person, tintColor: Color.Orange }}
              />
            )}
            
            {mediaSession.album && (
              <List.Item
                title="Album"
                subtitle={mediaSession.album}
                icon={{ source: Icon.Music, tintColor: Color.Purple }}
              />
            )}
            
            {mediaSession.genre && (
              <List.Item
                title="Genre"
                subtitle={mediaSession.genre}
                icon={{ source: Icon.Tag, tintColor: Color.Green }}
              />
            )}
            
            {mediaSession.playlistName && (
              <List.Item
                title="Playlist"
                subtitle={mediaSession.playlistName}
                icon={{ source: Icon.List, tintColor: Color.Blue }}
              />
            )}
            
            {(mediaSession.duration || mediaSession.position) && (
              <List.Item
                title="Progress"
                subtitle={formatProgress(mediaSession.position, mediaSession.duration)}
                accessories={[
                  { text: formatDuration(mediaSession.duration) }
                ]}
                icon={{ source: Icon.Clock, tintColor: Color.SecondaryText }}
              />
            )}
          </List.Section>

          {/* Playback Controls */}
          <List.Section title="Playback Controls">
            <List.Item
              title="Play/Pause"
              subtitle={mediaSession.isPlaying ? "Currently playing" : "Currently paused"}
              icon={{ source: getPlaybackIcon(), tintColor: getPlaybackColor() }}
              actions={
                <ActionPanel>
                  <Action
                    title={mediaSession.isPlaying ? "Pause" : "Play"}
                    icon={mediaSession.isPlaying ? Icon.Pause : Icon.Play}
                    onAction={() => handleMediaControl("toggle")}
                    shortcut={{ modifiers: ["cmd"], key: "space" }}
                  />
                </ActionPanel>
              }
            />

            {mediaSession.canSkipPrevious && (
              <List.Item
                title="Previous Track"
                subtitle="Skip to previous track"
                icon={{ source: Icon.Backward, tintColor: Color.Blue }}
                actions={
                  <ActionPanel>
                    <Action
                      title="Previous"
                      icon={Icon.Backward}
                      onAction={() => handleMediaControl("previous")}
                      shortcut={{ modifiers: ["cmd"], key: "arrowLeft" }}
                    />
                  </ActionPanel>
                }
              />
            )}

            {mediaSession.canSkipNext && (
              <List.Item
                title="Next Track"
                subtitle="Skip to next track"
                icon={{ source: Icon.Forward, tintColor: Color.Blue }}
                actions={
                  <ActionPanel>
                    <Action
                      title="Next"
                      icon={Icon.Forward}
                      onAction={() => handleMediaControl("next")}
                      shortcut={{ modifiers: ["cmd"], key: "arrowRight" }}
                    />
                  </ActionPanel>
                }
              />
            )}
          </List.Section>

          {/* Volume Controls */}
          {volume !== null && (
            <List.Section title="Volume Controls">
              <List.Item
                title="Volume"
                subtitle={`Current volume: ${volume}%`}
                accessories={[{ text: `${volume}%` }]}
                icon={{ 
                  source: volume === 0 ? Icon.SpeakerOff : volume < 50 ? Icon.SpeakerDown : Icon.SpeakerUp,
                  tintColor: Color.Blue 
                }}
                actions={
                  <ActionPanel>
                    <Action
                      title="Volume Up"
                      icon={Icon.Plus}
                      onAction={() => handleVolumeControl("up")}
                      shortcut={{ modifiers: ["cmd"], key: "arrowUp" }}
                    />
                    <Action
                      title="Volume Down"
                      icon={Icon.Minus}
                      onAction={() => handleVolumeControl("down")}
                      shortcut={{ modifiers: ["cmd"], key: "arrowDown" }}
                    />
                    <Action
                      title="Mute/Unmute"
                      icon={Icon.SpeakerOff}
                      onAction={() => handleVolumeControl("mute")}
                      shortcut={{ modifiers: ["cmd"], key: "m" }}
                    />
                  </ActionPanel>
                }
              />
            </List.Section>
          )}

          {/* Status Info */}
          <List.Section title="Status">
            <List.Item
              title="Last Updated"
              subtitle={formatLastRefresh()}
              icon={{ source: Icon.Clock, tintColor: Color.SecondaryText }}
              actions={
                <ActionPanel>
                  <Action
                    title="Refresh Now"
                    icon={Icon.ArrowClockwise}
                    onAction={refreshMediaInfo}
                    shortcut={{ modifiers: ["cmd"], key: "r" }}
                  />
                </ActionPanel>
              }
            />
          </List.Section>
        </>
      )}
    </List>
  );
}
