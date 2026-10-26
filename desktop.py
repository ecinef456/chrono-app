#!/usr/bin/env python3
"""Chrono as its own desktop app: a native Qt window, no browser needed.

If the Chrono background service is already running (./install.sh), the window
connects to it. Otherwise this starts the server itself and stops it again when
you close the window.
"""
import os
import socket
import sys
import threading
import time
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
PORT = 8765
URL = f"http://127.0.0.1:{PORT}"
ICON = str(BASE_DIR / "static" / "icon-512.png")
STORAGE = Path.home() / ".local" / "share" / "chrono" / "window"


def server_running() -> bool:
    try:
        with socket.create_connection(("127.0.0.1", PORT), timeout=0.3):
            return True
    except OSError:
        return False


def start_server():
    import uvicorn
    sys.path.insert(0, str(BASE_DIR))
    from app import app
    config = uvicorn.Config(app, host="127.0.0.1", port=PORT, log_level="warning")
    threading.Thread(target=uvicorn.Server(config).run, daemon=True).start()
    for _ in range(100):
        if server_running():
            return
        time.sleep(0.05)
    sys.exit("Chrono's server did not start. Is port 8765 used by something else?")


def enable_downloads(webview):
    """Let the window save files (e.g. Log > Export .txt) through a normal save dialog.

    pywebview's own handler targets Qt5 and proposes the URL path as file name, so we use the
    name the server suggests and default to ~/Downloads instead.
    """
    from qtpy.QtWidgets import QFileDialog
    from webview.platforms import qt as webview_qt

    def on_download_requested(view, download):
        name = download.downloadFileName() or "chrono-export.txt"
        downloads = Path.home() / "Downloads"
        start_dir = downloads if downloads.is_dir() else Path.home()
        path, _ = QFileDialog.getSaveFileName(view, "Save export", str(start_dir / name),
                                              "Text files (*.txt);;All files (*)")
        if not path:
            download.cancel()
            return
        download.setDownloadDirectory(str(Path(path).parent))
        download.setDownloadFileName(Path(path).name)
        download.accept()

    webview_qt.BrowserView.on_download_requested = on_download_requested
    webview.settings["ALLOW_DOWNLOADS"] = True


def main():
    os.environ.setdefault("QT_QPA_PLATFORMTHEME", "kde")
    import webview
    import webview.platforms.qt  # noqa: F401  (loads Qt WebEngine, which must happen before QApplication exists)
    from qtpy.QtGui import QIcon
    from qtpy.QtWidgets import QApplication

    # Create the Qt app ourselves so KDE matches the window to chrono.desktop
    # (taskbar icon and name, on both Wayland and X11).
    qt_app = QApplication.instance() or QApplication(sys.argv)
    qt_app.setApplicationName("Chrono")
    qt_app.setDesktopFileName("chrono")
    qt_app.setWindowIcon(QIcon(ICON))

    if not server_running():
        start_server()

    enable_downloads(webview)

    STORAGE.mkdir(parents=True, exist_ok=True)
    # The ?launch= value is new on every start, so the window can never reuse an old cached page.
    webview.create_window("Chrono", f"{URL}/?launch={int(time.time())}", width=1280, height=900, min_size=(380, 500),
                          background_color="#e8ecf0", text_select=True)
    # private_mode=False keeps the small per-window settings (theme, last course) between launches.
    webview.start(gui="qt", private_mode=False, storage_path=str(STORAGE), icon=ICON)


if __name__ == "__main__":
    main()
