# Discord Spoiler Tags — SillyTavern Extension

Renders `||text||` as clickable Discord-style spoiler blocks inside AI (and user) messages.

## What it does

Any text wrapped in double pipes like `||this is a spoiler||` will be hidden behind a dark pill. Click it once to reveal the text, click again to hide it — exactly like Discord spoiler tags.

## Installation

### Via SillyTavern's built-in Extension Installer (recommended)

1. Open SillyTavern.
2. Go to **Extensions → Install Extension**.
3. Paste the URL of this GitHub repository and click **Install**.

### Manual

1. Clone or download this repo.
2. Copy the folder into `SillyTavern/public/scripts/extensions/third-party/`.
3. Restart SillyTavern and enable the extension under **Extensions**.

## Usage

Just include `||spoiler text||` anywhere in a message — either in the AI's response or your own — and it will be automatically converted:

```
The killer was ||Professor Plum in the library||.
```

Click the dark block to reveal `Professor Plum in the library`.

## Files

| File | Purpose |
|------|---------|
| `manifest.json` | Extension metadata (required by SillyTavern) |
| `index.js` | Core logic — regex replacement + event hooks |
| `style.css` | Discord-inspired spoiler visual style |

## Compatibility

Tested against SillyTavern 1.10+. Should work with both regular and streaming responses.
