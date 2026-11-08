#!/usr/bin/env python3
"""Chrono as its own desktop app: a native window, no browser needed.

Linux (Qt), Windows (Edge WebView2) and macOS (WebKit). This is also the entry point of
the packaged apps (AppImage, Chrono.exe, Chrono.app) that GitHub builds on every release.

If a Chrono server is already running (e.g. the background service from ./install.sh),
the window connects to it. Otherwise this starts the server itself and stops it again when
you close the window.
"""
import json
import os
import socket
import sys
import threading
import time
import urllib.request
from pathlib import Path

RES_DIR = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))
PORT = 8765
ICON = str(RES_DIR / "static" / "icon-512.png")
LINUX = sys.platform.startswith("linux")


def storage_dir() -> Path:
    """Small per-window settings (theme, last tab) between launches."""
    if sys.platform == "win32":
        return Path(os.environ.get("LOCALAPPDATA", Path.home())) / "Chrono" / "window"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "Chrono" / "window"
    return Path.home() / ".local" / "share" / "chrono" / "window"


def port_open(port) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.3):
            return True
    except OSError:
        return False


def is_chrono(port) -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/meta", timeout=1) as r:
            return "categories" in json.load(r)
    except Exception:
        return False


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def start_server(port):
    import uvicorn
    import app  # noqa: imported here so the window appears fast when a server already runs
    config = uvicorn.Config(app.app, host="127.0.0.1", port=port, log_level="warning")
    threading.Thread(target=uvicorn.Server(config).run, daemon=True).start()
    for _ in range(200):
        if port_open(port):
            return
        time.sleep(0.05)
    sys.exit("Chrono's server did not start.")


def qt_setup(webview):
    """Linux: KDE/GNOME integration (taskbar icon, native save dialog for exports)."""
    # The Qt bundled with pywebview can't load KDE's own theme plugin; the desktop portal
    # hands file dialogs to the desktop itself (native look, your bookmarks and folders).
    os.environ.setdefault("QT_QPA_PLATFORMTHEME", "xdgdesktopportal")
    import webview.platforms.qt  # noqa: F401  (loads Qt WebEngine before QApplication exists)
    from qtpy.QtGui import QIcon
    from qtpy.QtWidgets import QApplication, QFileDialog
    from webview.platforms import qt as webview_qt

    # Create the Qt app ourselves so the desktop matches the window to chrono.desktop.
    qt_app = QApplication.instance() or QApplication(sys.argv)
    qt_app.setApplicationName("Chrono")
    qt_app.setDesktopFileName("chrono")
    qt_app.setWindowIcon(QIcon(ICON))

    # pywebview's own download handler targets Qt5 and proposes the URL path as file name.
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


class WindowApi:
    """Window buttons and moving/resizing for the frameless Linux window, called from the page
    (window.pywebview.api.*). Moving and resizing go through the desktop itself
    (startSystemMove/-Resize), which also works on Wayland, where apps may not place windows."""

    def __init__(self):
        self.window = None
        self._gui = None           # runs a function on Qt's main thread

    def frameless(self):
        return LINUX

    def minimize(self):
        self.window.minimize()

    def toggle_maximize(self):
        def run():
            w = self.window.native
            w.showNormal() if w.isMaximized() else w.showMaximized()
        self._gui(run)

    def close(self):
        self.window.destroy()

    def start_move(self):
        self._gui(lambda: self.window.native.windowHandle().startSystemMove())

    def start_resize(self, edge):
        from qtpy.QtCore import Qt
        edges = {"left": Qt.LeftEdge, "right": Qt.RightEdge, "top": Qt.TopEdge, "bottom": Qt.BottomEdge,
                 "top-left": Qt.TopEdge | Qt.LeftEdge, "top-right": Qt.TopEdge | Qt.RightEdge,
                 "bottom-left": Qt.BottomEdge | Qt.LeftEdge, "bottom-right": Qt.BottomEdge | Qt.RightEdge}
        if edge in edges:
            self._gui(lambda: self.window.native.windowHandle().startSystemResize(edges[edge]))


def gui_runner():
    """A function that runs callables on the Qt main thread (page calls arrive on other threads)."""
    from qtpy.QtCore import QObject, Signal

    class Bridge(QObject):
        call = Signal(object)

    bridge = Bridge()
    bridge.call.connect(lambda f: f())
    gui_runner.keep = bridge          # keep it alive
    return bridge.call.emit


def main():
    import webview

    api = WindowApi()
    if LINUX:
        qt_setup(webview)
        api._gui = gui_runner()
    webview.settings["ALLOW_DOWNLOADS"] = True

    port = PORT
    if not is_chrono(port):
        if port_open(port):          # something else uses 8765: take any free port
            port = free_port()
        start_server(port)

    storage = storage_dir()
    storage.mkdir(parents=True, exist_ok=True)
    # The ?launch= value is new on every start, so the window never reuses an old cached page.
    # Linux: no title bar from the desktop; Chrono's header has the window buttons and moves the window.
    api.window = webview.create_window("Chrono", f"http://127.0.0.1:{port}/?launch={int(time.time())}",
                                       width=1280, height=900, min_size=(380, 500),
                                       background_color="#e8ecf0", text_select=True,
                                       frameless=LINUX, easy_drag=False, js_api=api)
    # private_mode=False keeps the small per-window settings between launches.
    webview.start(gui="qt" if LINUX else None, private_mode=False, storage_path=str(storage), icon=ICON)


if __name__ == "__main__":
    main()
