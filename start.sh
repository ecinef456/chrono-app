#!/usr/bin/env bash
# Starts Chrono. First run creates a virtual environment and installs dependencies.
set -e
cd "$(dirname "$0")"
if [ ! -d .venv ]; then
  echo "First run: setting up .venv ..."
  python3 -m venv .venv
  .venv/bin/pip install -q -r requirements.txt
fi
exec .venv/bin/python app.py "$@"
