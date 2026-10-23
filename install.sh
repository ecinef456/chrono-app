#!/usr/bin/env bash
# One-time setup (Linux): installs dependencies and makes Chrono start automatically
# when you log in. Afterwards just open http://127.0.0.1:8765 or the installed app icon.
set -e
cd "$(dirname "$0")"
DIR="$(pwd)"
if [ ! -d .venv ]; then
  python3 -m venv .venv
fi
.venv/bin/pip install -q -r requirements.txt

mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/chrono.service <<UNIT
[Unit]
Description=Chrono study tracker

[Service]
WorkingDirectory=$DIR
ExecStart=$DIR/.venv/bin/python $DIR/app.py --no-browser
Restart=on-failure

[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user enable --now chrono
sleep 1
echo "Chrono is running and will start automatically on every login."
echo "Open http://127.0.0.1:8765  (in Chrome: install it as an app from the address bar)"
echo "Stop autostart any time with:  systemctl --user disable --now chrono"
command -v xdg-open >/dev/null && xdg-open http://127.0.0.1:8765 >/dev/null 2>&1 || true
