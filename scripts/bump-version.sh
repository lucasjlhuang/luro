#!/usr/bin/env bash
# Bump the version in every place it lives, then commit and tag.
#
# tauri.conf.json's version is what the updater compares against. If it drifts
# from the git tag, the release builds fine and then silently updates nobody,
# with nothing in the logs to say why — so all three files move together here.
#
#   ./scripts/bump-version.sh 0.2.0
#   git push origin main --follow-tags
set -euo pipefail

VERSION="${1:-}"
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "usage: $0 <major.minor.patch>   e.g. $0 0.2.0" >&2
  exit 1
fi

cd "$(dirname "$0")/.."

if [ -n "$(git status --porcelain)" ]; then
  echo "Working tree is dirty — commit or stash first." >&2
  exit 1
fi

if git rev-parse "v$VERSION" >/dev/null 2>&1; then
  echo "Tag v$VERSION already exists." >&2
  exit 1
fi

python3 - "$VERSION" <<'PY'
import json, re, sys

version = sys.argv[1]

for path, key in (("package.json", "version"), ("src-tauri/tauri.conf.json", "version")):
    with open(path) as f:
        data = json.load(f)
    data[key] = version
    with open(path, "w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")

# Only the [package] version at the top of Cargo.toml, never a dependency's.
src = open("src-tauri/Cargo.toml").read()
src = re.sub(r'(?m)^(version = ")[^"]+(")', rf'\g<1>{version}\g<2>', src, count=1)
open("src-tauri/Cargo.toml", "w").write(src)

# Keep the lockfile's own entry in step so the next build is not dirty.
lock = open("src-tauri/Cargo.lock").read()
lock = re.sub(
    r'(?ms)(\[\[package\]\]\nname = "luro"\nversion = ")[^"]+(")',
    rf'\g<1>{version}\g<2>',
    lock,
    count=1,
)
open("src-tauri/Cargo.lock", "w").write(lock)
print(f"set version to {version}")
PY

git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "Release v$VERSION"
git tag -a "v$VERSION" -m "luro v$VERSION"

echo
echo "Committed and tagged v$VERSION. To build and publish:"
echo "  git push origin main --follow-tags"
