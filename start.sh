#!/usr/bin/env bash
# Keine Installation: vorhandenes Python nutzen und nur auf Loopback lauschen.
set -eu
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# Dateimanager können Skripte ohne Terminal ausführen. In einer grafischen Sitzung
# dann einen Terminalemulator starten und alle Argumente unverändert weiterreichen.
# Die Markierung verhindert eine Startschleife, falls ein Emulator kein TTY liefert.
if [[ ! -t 0 && ! -t 1 && ! -t 2 ]] &&
   [[ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]] &&
   [[ "${BIKE_EKG_WEB_TERMINAL:-}" != 1 ]]; then
  export BIKE_EKG_WEB_TERMINAL=1
  if command -v xdg-terminal-exec >/dev/null 2>&1; then
    exec xdg-terminal-exec "$BASH" "$SCRIPT_DIR/start.sh" "$@"
  elif command -v konsole >/dev/null 2>&1; then
    exec konsole --separate -e "$BASH" "$SCRIPT_DIR/start.sh" "$@"
  elif command -v gnome-terminal >/dev/null 2>&1; then
    exec gnome-terminal -- "$BASH" "$SCRIPT_DIR/start.sh" "$@"
  elif command -v xfce4-terminal >/dev/null 2>&1; then
    exec xfce4-terminal --disable-server -x "$BASH" "$SCRIPT_DIR/start.sh" "$@"
  elif command -v kitty >/dev/null 2>&1; then
    exec kitty -- "$BASH" "$SCRIPT_DIR/start.sh" "$@"
  elif command -v alacritty >/dev/null 2>&1; then
    exec alacritty -e "$BASH" "$SCRIPT_DIR/start.sh" "$@"
  elif command -v x-terminal-emulator >/dev/null 2>&1; then
    exec x-terminal-emulator -e "$BASH" "$SCRIPT_DIR/start.sh" "$@"
  elif command -v xterm >/dev/null 2>&1; then
    exec xterm -e "$BASH" "$SCRIPT_DIR/start.sh" "$@"
  fi
  message='Kein Terminalprogramm gefunden. Bitte ein Terminal oeffnen und im Projektordner bash start.sh ausfuehren.'
  printf '%s\n' "$message" >&2
  if command -v kdialog >/dev/null 2>&1; then
    kdialog --error "$message" || true
  elif command -v zenity >/dev/null 2>&1; then
    zenity --error --text="$message" || true
  fi
  exit 1
fi

fail() {
  printf '%s\n' "$1" >&2
  # Ein durch Doppelklick gestartetes Fenster bei Fehlern nicht sofort schliessen.
  if [[ -t 0 ]]; then
    read -r -p 'Enter druecken, um das Fenster zu schliessen ...' || true
  fi
  exit 1
}

for python in python3 python; do
  if command -v "$python" >/dev/null 2>&1 &&
     "$python" -c 'import sys; assert sys.version_info >= (3, 9)' >/dev/null 2>&1; then
    if "$python" "$SCRIPT_DIR/start.py" "$@"; then
      exit 0
    else
      fail 'Der lokale Server wurde mit einem Fehler beendet.'
    fi
  fi
done
fail 'Python 3.9 oder neuer fehlt. Bitte installieren und erneut starten.'
