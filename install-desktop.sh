#!/usr/bin/env bash
# Adds Chrono to your app menu (KDE, GNOME, ...) as a standalone app with its own window.
# Run once from the chrono-app folder. Re-run it if you move the folder.
set -e
cd "$(dirname "$0")"
DIR="$(pwd)"

if [ ! -d .venv ]; then
  python3 -m venv .venv
fi
echo "Installing the window toolkit (PyQt6 WebEngine, about 150 MB, one time) ..."
.venv/bin/pip install -q -r requirements.txt "pywebview[qt]>=5"

mkdir -p ~/.local/share/applications
cat > ~/.local/share/applications/chrono.desktop <<EOF
[Desktop Entry]
Type=Application
Name=Chrono
GenericName=Study tracker
Comment=Track study time per course
Exec=$DIR/.venv/bin/python $DIR/desktop.py
Icon=$DIR/static/icon-512.png
Terminal=false
Categories=Education;Utility;
StartupWMClass=Chrono
StartupNotify=true
EOF
update-desktop-database ~/.local/share/applications >/dev/null 2>&1 || true
kbuildsycoca6 >/dev/null 2>&1 || kbuildsycoca5 >/dev/null 2>&1 || true

echo "Done. Chrono is now in your app menu (search 'Chrono'); right-click it to pin it to the taskbar."
