#!/bin/sh
# Installs Savor on Linux: the newest AppImage from the GitHub releases as ~/Applications/Savor.AppImage
# and an entry in the app menu. The file name carries no version, so the app's own updates replace it in
# place. Running the script again installs the newest release.
#
#   curl -fsSL https://savor.pleasance.org/install.sh | sh
#
# To remove Savor, delete ~/Applications/Savor.AppImage, ~/.local/share/applications/savor.desktop and
# ~/.local/share/icons/hicolor/scalable/apps/savor.svg. Its data stays in ~/.savor and in .savor/ inside
# your projects.
set -eu

repo=https://github.com/robinchoice/savor
apps=$HOME/Applications
data=${XDG_DATA_HOME:-$HOME/.local/share}

fail() {
  echo "savor: $*" >&2
  exit 1
}

[ "$(uname -s)" = Linux ] || fail "this script is for Linux. On macOS: brew install --cask robinchoice/tap/savor"
[ "$(uname -m)" = x86_64 ] || fail "the Linux app is built for x86_64 only, this computer is $(uname -m). Run Savor from source: $repo#install"
command -v curl >/dev/null || fail "curl is missing"

# The latest release redirects to its tag, which spares the API and its rate limit.
tag=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "$repo/releases/latest")
tag=${tag##*/}
version=${tag#v}
case $version in
  [0-9]*.[0-9]*.[0-9]*) ;;
  *) fail "could not find the latest release" ;;
esac

echo "Downloading Savor $version"
mkdir -p "$apps" "$data/applications" "$data/icons/hicolor/scalable/apps"
part=$apps/.Savor.AppImage.part
trap 'rm -f "$part"' EXIT
curl -fL --progress-bar -o "$part" "$repo/releases/download/$tag/Savor-$version.AppImage"
chmod +x "$part"
mv -f "$part" "$apps/Savor.AppImage"

curl -fsSL -o "$data/icons/hicolor/scalable/apps/savor.svg" https://savor.pleasance.org/img/savor-tile.svg || true
cat >"$data/applications/savor.desktop" <<EOF
[Desktop Entry]
Name=Savor
Comment=Workspace for coding agents that report back
Exec="$apps/Savor.AppImage"
Icon=savor
Terminal=false
Type=Application
Categories=Development;
StartupWMClass=Savor
EOF
command -v update-desktop-database >/dev/null && update-desktop-database -q "$data/applications" || true

echo "Savor $version is in $apps/Savor.AppImage and in your app menu."
# AppImages mount themselves through FUSE 2, which recent Ubuntu and Debian no longer install by default.
if ! { /sbin/ldconfig -p 2>/dev/null || ldconfig -p 2>/dev/null; } | grep -q 'libfuse\.so\.2'; then
  echo "It needs FUSE 2 to start. On Ubuntu 24.04 and later: sudo apt install libfuse2t64, on older Ubuntu and Debian: sudo apt install libfuse2."
fi
echo "Savor drives the agent CLIs you are signed in to: Claude Code, Codex or OpenCode."
