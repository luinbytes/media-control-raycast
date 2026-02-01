# Contributing to Media Control

Thank you for your interest in contributing to Media Control! This document provides guidelines and instructions for contributing to this Raycast Windows extension.

## Getting Started

### Prerequisites
- **Node.js** (18.x or later recommended)
- **Raycast for Windows** - Download from [raycast.com](https://raycast.com/)
- Basic knowledge of:
  - TypeScript
  - React
  - Windows PowerShell scripting
  - Windows Media APIs

### Development Setup

1. **Clone the repository**:
   ```bash
   git clone https://github.com/luinbytes/media-control-raycast.git
   cd media-control-raycast
   ```

2. **Install dependencies**:
   ```bash
   npm ci
   ```

3. **Start development mode**:
   ```bash
   npm run dev
   ```

4. **The extension will be automatically added to your Raycast installation**

## Code Style Guidelines

### TypeScript
- Use TypeScript for type safety
- Define interfaces for all data structures
- Avoid `any` type when possible
- Use proper type assertions with care

### React
- Use functional components with hooks
- Keep components focused and small
- Follow Raycast extension patterns
- Use `@raycast/api` components properly

### PowerShell Scripts
- Keep PowerShell scripts in `utils/mediaUtils.ts` as template strings
- Use temp file strategy to avoid command-line length limits
- Clean up temp files with `finally` blocks
- Use `-File` flag for execution to avoid quoting issues

### General
- Use meaningful variable and function names
- Add comments for complex logic
- Keep functions short and focused
- Follow existing code structure and style

## Testing

### Manual Testing
Since this is a Windows-specific Raycast extension with PowerShell integration, manual testing is crucial:

1. **Test media detection**:
   - Play media in different apps (Spotify, YouTube in various browsers, VLC)
   - Verify correct app detection and title extraction
   - Test fallback mechanisms when primary detection fails

2. **Test media controls**:
   - Play/pause toggle
   - Next/previous track
   - Volume controls (up/down/mute)
   - Verify commands work across different media players

3. **Test edge cases**:
   - No media playing
   - Multiple media sources playing simultaneously
   - Browser windows with complex titles
   - Different browser types (Chrome, Edge, Firefox, Zen)

4. **Test performance**:
   - Verify low resource usage
   - Check that polling doesn't impact system performance
   - Ensure temp files are cleaned up properly

### Test Checklist Before Submitting
- [ ] Extension loads without errors in Raycast
- [ ] Media detection works with at least 3 different apps
- [ ] All control buttons function correctly
- [ ] Volume controls work in 10% increments
- [ ] Auto-refresh updates correctly every 2 seconds
- [ ] Temp files are cleaned up after execution
- [ ] No PowerShell execution errors in logs
- [ ] UI renders correctly with all media types

## PowerShell Script Best Practices

This extension uses PowerShell for Windows API interactions. Follow these guidelines:

### Temp File Strategy
```typescript
// Good - Use createTempPsFile utility
const script = `
    # PowerShell code here
`;
const scriptPath = createTempPsFile(script);
try {
    // Execute with -File flag
    const result = await execFile(`powershell.exe -ExecutionPolicy Bypass -File "${scriptPath}"`);
} finally {
    // Clean up temp file
    await unlink(scriptPath);
}
```

### Why This Matters
- Avoids Windows command-line length limits (~8191 characters)
- Prevents quoting issues with complex scripts
- Ensures temp files are cleaned up (prevents EBUSY errors)
- `-File` flag is more reliable than `-Command`

## Submitting Changes

### Pull Request Process

1. **Fork the repository** and create your branch:
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. **Make your changes** and test thoroughly

3. **Commit your changes**:
   ```bash
   git add .
   git commit -m "feat: add your feature description"
   ```

4. **Push to your fork** and submit a PR:
   ```bash
   git push origin feature/your-feature-name
   ```

### Commit Message Convention

Use clear, descriptive commit messages:
- `feat:` - New feature
- `fix:` - Bug fix
- `docs:` - Documentation changes
- `refactor:` - Code refactoring (no functional change)
- `style:` - Code style changes (formatting, etc.)
- `test:` - Adding or updating tests
- `chore:` - Maintenance tasks

Example:
```
feat: add support for custom media apps via configuration
```

### Pull Request Description

Include in your PR:
- Clear description of changes
- Reason for the change
- Testing performed
- Screenshots if UI changes
- Affected media apps tested
- Related issues (if any)

Example:
```
## Changes
- Added support for custom media app detection patterns
- Added configuration option for custom window title regex
- Updated README with configuration examples

## Testing
- Tested with custom media app (foobar2000)
- Verified custom regex patterns work correctly
- Tested that default patterns still work

## Related Issues
Fixes #42
```

## Reporting Bugs

When reporting bugs, please include:
- **Environment**: Windows version, Raycast version
- **Raycast Extension Version**: [e.g., 1.0.0]
- **Media App**: [e.g., Spotify 1.2.5]
- **Steps to reproduce**: Clear, step-by-step instructions
- **Expected behavior**: What should happen
- **Actual behavior**: What actually happens
- **Logs**: PowerShell or Raycast logs if available
- **Additional context**: Any other relevant information

Use the [issue template](.github/ISSUE_TEMPLATE/bug_report.md) when reporting bugs.

## Suggesting Features

Feature suggestions are welcome! Please include:
- **Problem statement**: What problem does this solve?
- **Proposed solution**: How should it work?
- **Alternatives considered**: What other approaches did you think about?
- **Use cases**: How would you use this feature?
- **Additional context**: Examples, mockups, references

Use the [feature request template](.github/ISSUE_TEMPLATE/feature_request.md) when suggesting features.

## Windows-Specific Considerations

### PowerShell Execution
- Always use `-ExecutionPolicy Bypass` for scripts
- Use `-File` flag to execute temp scripts
- Clean up temp files in `finally` blocks
- Handle Windows-specific path separators (`\\`)

### Media APIs
- Test with both SMTC and window-title detection
- Consider foreground window bonus in scoring
- Handle paused vs playing states appropriately
- Account for different browser types and their title formats

### Volume Control
- Use Windows Audio Device APIs
- Test with different audio output devices
- Handle case where no audio is playing
- Ensure volume increments are 10% as documented

## Code of Conduct

- Be respectful and constructive
- Focus on what is best for the community
- Show empathy towards other community members
- Accept feedback gracefully
- Help others when possible

## Questions?

Feel free to:
- Open an issue for questions
- Check [Raycast documentation](https://developers.raycast.com/)
- Review other Raycast Windows extensions for patterns

Happy contributing! ✨
