#!/usr/bin/env bash
# Copy the freshly built app over the one in /Applications, so the installed
# copy is never a stale snapshot. macOS only; run via `npm run release`.
set -euo pipefail

APP_NAME="luro.app"
SRC="src-tauri/target/release/bundle/macos/$APP_NAME"
DEST="/Applications/$APP_NAME"

if [ ! -d "$SRC" ]; then
  echo "No build at $SRC — run 'npm run tauri build' first." >&2
  exit 1
fi

# Replace rather than copy over the top: cp -R onto an existing bundle leaves
# files from the previous version behind inside it.
if [ -e "$DEST" ] && [ ! -d "$DEST/Contents" ]; then
  echo "$DEST exists but is not an app bundle — refusing to remove it." >&2
  exit 1
fi
rm -rf "$DEST"
cp -R "$SRC" "$DEST"

echo "Installed $DEST"
