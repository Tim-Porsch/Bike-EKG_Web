#!/usr/bin/env python3
"""Lokaler Offline-Starter. Nur Python-Standardbibliothek, kein Paketdownload."""

import argparse
import errno
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import os
from pathlib import Path
import shutil
import subprocess
import sys
import threading
import webbrowser


ROOT = Path(__file__).resolve().parent


def create_server(port):
    """Nur Loopback binden; Verzeichnis unabhängig vom Aufrufpfad festlegen."""
    handler = partial(SimpleHTTPRequestHandler, directory=str(ROOT))
    server = ThreadingHTTPServer(("127.0.0.1", port), handler)
    server.daemon_threads = True
    return server


def browser_command():
    """Unterstützte Browser bevorzugen, ohne eine Installation vorauszusetzen."""
    if sys.platform == "win32":
        for base in ("PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"):
            directory = os.environ.get(base)
            if not directory:
                continue
            for relative in ("Microsoft/Edge/Application/msedge.exe",
                             "Google/Chrome/Application/chrome.exe"):
                candidate = Path(directory) / relative
                if candidate.is_file():
                    return str(candidate)
    else:
        for name in ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser",
                     "microsoft-edge", "microsoft-edge-stable"):
            candidate = shutil.which(name)
            if candidate:
                return candidate
    return None


def open_browser(url):
    """Ein Browserfehler darf den lokalen Server nicht beenden."""
    try:
        command = browser_command()
        if command:
            subprocess.Popen([command, url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        else:
            print("Falls noetig: Adresse manuell in Chrome/Chromium/Edge oeffnen.", flush=True)
            webbrowser.open(url)
    except (OSError, webbrowser.Error) as error:
        print("Browser konnte nicht automatisch geoeffnet werden: {}".format(error), flush=True)


def port_number(text):
    try:
        value = int(text)
    except ValueError:
        raise argparse.ArgumentTypeError("Port muss eine ganze Zahl sein.")
    if not 0 <= value <= 65535:
        raise argparse.ArgumentTypeError("Port muss zwischen 0 und 65535 liegen.")
    return value


def main(argv=None):
    parser = argparse.ArgumentParser(description="Bike-EKG_Web lokal und offline starten")
    parser.add_argument("--port", type=port_number, default=8765,
                        help="Lokaler Port (Standard 8765; 0 waehlt einen freien Port)")
    parser.add_argument("--no-browser", action="store_true", help="Browser nicht automatisch oeffnen")
    args = parser.parse_args(argv)
    try:
        try:
            server = create_server(args.port)
        except OSError as error:
            # Keine Verbindung zu einem fremden Dienst am belegten Port oeffnen.
            if error.errno != errno.EADDRINUSE and getattr(error, "winerror", None) != 10048:
                raise
            print("Port belegt; verwende einen freien lokalen Port.", flush=True)
            server = create_server(0)
    except OSError as error:
        print("Lokaler Server konnte nicht gestartet werden: {}".format(error), file=sys.stderr)
        return 1

    with server:
        url = "http://127.0.0.1:{}/".format(server.server_port)
        print("Bike-EKG_Web: " + url, flush=True)
        print("Terminal offen lassen. Beenden mit Strg+C. Kein Internet erforderlich.", flush=True)
        if not args.no_browser:
            threading.Thread(target=open_browser, args=(url,), daemon=True).start()
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            print("\nBike-EKG_Web beendet.", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
