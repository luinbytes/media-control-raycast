# Media Control - Raycast Extension for Windows

A seamless Windows media control extension for Raycast that automatically detects and controls your primary media source.

## Features

### 🎵 **Smart Media Detection**
- Automatically detects the currently active media session on Windows
- Works with any media player that supports Windows Media Transport Controls
- Explicit YouTube title detection for Chrome, Brave, Microsoft Edge, Firefox, and Zen Browser
- Real-time updates of playback status and track information

#### Smart Selection (Option C)
- Prioritizes likely video sources (YouTube in browsers) over music when appropriate.
- Favors live streams (small bonus) and penalizes paused sessions.
- If browsers are paused and Spotify is playing, Spotify will be selected.

### 🎮 **Comprehensive Controls**
- **Play/Pause Toggle** - `Cmd+Space`
- **Next Track** - `Cmd+Right Arrow`
- **Previous Track** - `Cmd+Left Arrow`
- **Volume Control** - `Cmd+Up/Down Arrow`
- **Quick Mute** - `Cmd+M`

### 🎨 **Rich Interface**
- Live track information (title, artist, album)
- Visual playback status indicators
- App identification (Spotify, Chrome, VLC, etc.)
- Real-time volume display
- Last updated timestamps

### ⚡ **Powerful Actions**
- Instant media control without switching apps
- Volume adjustment in 10% increments
- Quick volume presets (50%, 100%)
- Auto-refresh every 2 seconds
- Manual refresh with `Cmd+R`

## Installation

### Prerequisites
- **Node.js** - Install via `winget install -e --id OpenJS.NodeJS`
- **Raycast for Windows** - Download from [raycast.com](https://raycast.com/)

### Setup
1. **Clone this repository:**
   ```bash
   git clone <repository-url>
   cd media-control-raycast
   ```

2. **Install dependencies:**
   ```bash
   npm ci
   ```

3. **Start development mode:**
   ```bash
   npm run dev
   ```

4. **The extension will be automatically added to your Raycast installation**

## Usage

1. **Open Raycast** (`Alt+Space` by default)
2. **Type "media"** to find the Media Control extension
3. **View current track** information and playback status
4. **Use keyboard shortcuts** for quick control:
   - `Cmd+Space` - Play/Pause
   - `Cmd+Left/Right` - Previous/Next track
   - `Cmd+Up/Down` - Volume up/down
   - `Cmd+M` - Mute
   - `Cmd+R` - Refresh

## Supported Media Players

This extension works with any Windows application that implements the Windows Media Transport Controls API, including:

- **Spotify**
- **Chrome/Edge/Firefox** (YouTube, web players)
- **VLC Media Player**
- **Windows Media Player**
- **iTunes**
- **foobar2000**
- **And many more...**

## Technical Details

### Architecture
- **Platform:** Windows 10/11
- **Technology:** TypeScript, React, Raycast API
- **Media API:** Windows Media Transport Controls (GlobalSystemMediaTransportControlsSessionManager)
- **Volume Control:** Windows Audio Device APIs via PowerShell

### How It Works
1. **Media Detection:** Uses PowerShell to query processes and window titles, with app-specific patterns (Spotify, YouTube in Chrome/Brave/Edge/Firefox, VLC, etc.)
2. **Command Invocation:** The media detection script is written to a temporary .ps1 and executed via `-File` to avoid Windows command-line length limits
3. **Real-time Updates:** Polls media session every 2 seconds for live updates
4. **Control Commands:** Sends media control commands through Windows APIs
5. **Volume Management:** Integrates with Windows audio system for volume control

## Changelog

- 2025-08-09: Added explicit YouTube detection for Microsoft Edge and Firefox. Switched media detection PowerShell execution to `-File` to avoid command-line length limits.
- 2025-08-09: Added explicit YouTube detection for Zen Browser (supports hyphen or em dash before "Zen Browser").
- 2025-08-09: Implemented smart selection scoring (video-first, live bonus, paused penalty) to pick the most relevant active session.

### Performance
- **Lightweight:** Minimal resource usage with efficient polling
- **Fast Response:** Instant media control with sub-second response times
- **Error Handling:** Graceful fallbacks when no media is playing

## Development

### Project Structure
```
media-control-raycast/
├── src/
│   ├── index.tsx              # Main entry point
│   ├── media-control.tsx      # Main UI component
│   └── utils/
│       └── mediaUtils.ts      # Windows media API utilities
├── package.json               # Dependencies and metadata
├── tsconfig.json             # TypeScript configuration
└── README.md                 # This file
```

### Key Components
- **MediaSession Interface:** Type definitions for media session data
- **Media Utilities:** PowerShell integration for Windows APIs
- **UI Components:** Raycast List components with actions and shortcuts
- **State Management:** React hooks for real-time updates

## Contributing

Feel free to submit issues and enhancement requests! This extension follows the patterns established by other Raycast Windows extensions.

### Development Commands
```bash
npm run dev      # Start development mode
npm run build    # Build for production
npm run lint     # Run linting
npm run fix-lint # Fix linting issues
```

## License

MIT License - see LICENSE file for details.

## Credits & References

This extension builds upon the Windows Raycast extension patterns from:
- [windows-terminal](https://github.com/PuttTim/windows-terminal) by PuttTim
- [everything-raycast-extension](https://github.com/dougfernando/everything-raycast-extension) by dougfernando
- [kill-processes-ext](https://github.com/dougfernando/kill-processes-ext) by dougfernando

UI/UX inspiration from the official Raycast extensions ecosystem.

---

**Note:** This extension is currently not published to the Raycast Store as Windows extensions are not yet supported in the official store. Manual installation is required.
