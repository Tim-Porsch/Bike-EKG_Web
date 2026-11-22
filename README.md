# Bike-EKG_Web

> **Zugehörige MCU-Firmware:**
> [Bike-EKG – nRF52840-Firmware](https://github.com/Tim-Porsch/Bike-EKG-nrf52840firmware)
>
> Die Firmware für das Messsystem sowie Hinweise zur Hardware, zum Build und
> zu den BLE-Schnittstellen befinden sich im separaten Firmware-Repository.

Browseroberfläche zum Bike-EKG-Messsystem: Gerätesteuerung über Bluetooth,
Live-Vorschau, SD-Aufzeichnungen herunterladen sowie CSV-/BIN-Dateien lokal
visualisieren. Forschungsprototyp zur Bachelorarbeit von **Tim Pörschmann**,
kein medizinisches Überwachungs- oder Diagnosegerät.

## Einfach offline starten

Voraussetzungen: **Python 3.9 oder neuer**, **Chrome, Chromium oder Edge**,
für die Geräteverbindung zusätzlich Bluetooth und die passende Firmware.
Python ausschließlich von einer vertrauenswürdigen Quelle installieren.
Es werden **keine Python-Pakete**, kein Node.js und kein Internetzugang für
den normalen Betrieb benötigt. Download und Installation der Voraussetzungen
erfolgen natürlich vor der Offlinenutzung.

1. Dieses Repository herunterladen oder klonen und den vollständigen Ordner
   lokal ablegen (ein GitHub-ZIP vor dem Start vollständig entpacken).
2. **Windows:** `start.bat` doppelklicken. Python ggf. nachinstallieren und
   den Starter erneut öffnen.
3. **Linux:** `start.sh` ausführbar machen (`chmod +x start.sh`) und im
   Dateimanager **Ausführen** wählen. Ohne vorhandenes Terminal öffnet der
   Starter automatisch eines, z. B. Konsole unter KDE/CachyOS. Falls der
   Dateimanager stattdessen einen Editor öffnet, dessen Einstellung für
   ausführbare Textdateien ändern oder im Projektordner `bash start.sh` ausführen.
4. Der Starter öffnet die lokale Oberfläche möglichst in Chrome/Chromium/Edge.
   Falls ein anderer Browser erscheint oder der automatische Start nicht klappt:
   die im Terminal angezeigte Adresse in Chrome/Chromium/Edge öffnen.
5. Das Terminal geöffnet lassen. **Strg+C** beendet den lokalen Server.

Unter Windows öffnet `start.bat` beim Doppelklick selbst ein Konsolenfenster.
Unter Linux werden `xdg-terminal-exec`, Konsole, GNOME Terminal, Xfce Terminal,
Kitty, Alacritty, `x-terminal-emulator` oder XTerm automatisch erkannt. Beim
Start aus einem vorhandenen Terminal wird dieses weiterverwendet. Ohne grafische
Sitzung bleibt der Server im aufrufenden Prozess. Der Starter installiert
kein Terminalprogramm. Browser-Schließen allein beendet den Server nicht.

Der Server hört nur auf `127.0.0.1`, nicht im LAN. Standardport ist 8765;
falls dieser belegt ist, wird automatisch ein freier Port verwendet. Die
jeweils gültige Adresse steht im Terminal. `127.0.0.1` gilt wie `localhost`
als vertrauenswürdiger lokaler Kontext für Web Bluetooth und Web Worker.
Ein Direktstart von `index.html` über `file://` ist nicht zuverlässig.

Manueller Start, auch von einem anderen Arbeitsverzeichnis aus:

```bash
python3 start.py
# Windows alternativ: py -3 start.py
```

Ohne automatisches Browseröffnen: `python3 start.py --no-browser`.
Mit eigenem Port: `python3 start.py --port 9000`.

## Firmware und Bedienung

Das separate [Firmware-Repository](https://github.com/Tim-Porsch/Bike-EKG-nrf52840firmware)
enthält die MCU-Software und Protokolldokumentation. Diese Links benötigen
Internet; die Webapp selbst lädt von dort keine Dateien nach.

Details zu Verbindung, Filtern, Exporten und Browserunterstützung stehen in
[`docs/WEBAPP.md`](docs/WEBAPP.md). Firefox und Safari unterstützen die
BLE-Geräteverbindung nicht. Unter Linux können zusätzliche Chromium-/BlueZ-
Einstellungen erforderlich sein. Windows-/Linux-Kompatibilität der konkreten
Bluetooth-Hardware muss am Zielsystem geprüft werden.

## Daten und Sicherheit

- Dateien und Messdaten werden lokal verarbeitet; kein Backend, Tracking oder
  Upload durch die Anwendung. Es werden keine externen Webbibliotheken benötigt.
- Messwerte, Versuchspersonenangaben und Kommentare können sensibel sein:
  verantwortungsvoll speichern, nicht versehentlich in Git aufnehmen.
- BLE-Dienste des Forschungsprototyps sind offen konfiguriert. Nur in
  kontrollierten Umgebungen und elektrisch geeigneten, isolierten Prüfaufbauten nutzen.
- RLD kann ab Firmware 0.12.4 dauerhaft aktiviert sein. Die Warnungen in der
  Oberfläche beachten. Software ist kein Ersatz für elektrische Schutzmaßnahmen.
- Der lokale HTTP-Server ist ausschließlich ein Desktop-Starter, kein
  gehärteter öffentlicher Webserver. Für öffentliches Hosting statisches HTTPS
  verwenden, nicht diesen Server ins Internet freigeben.

## Entwicklung und Tests

Die Webapp besteht aus HTML, CSS und JavaScript ohne Buildschritt. Für die
Webtests wird Node.js 20.11+ benötigt, aber nicht für die normale Benutzung:

```bash
node --test tests/*.test.cjs
python3 -m unittest discover -s tests -p 'test_*.py'
```

Unter Windows kann für die Python-Tests `py -3` statt `python3` verwendet werden.
Die Tests verwenden synthetische Daten und ersetzen keine Hardwaretests.
Die Windows-Batchdatei muss zusätzlich auf einem echten Windows-System geprüft werden.

## Herkunft und Lizenz

Der Code wurde unter Nutzung von **OpenAI ChatGPT** entwickelt. Diese Angabe
ist keine Bestätigung durch OpenAI und kein Nachweis vollständiger Fehlerfreiheit
oder einer lückenlos geprüften Herkunft jedes Codebestandteils.

Dieses eigenständige Projekt basiert auf dem aktuellen lokalen Webapp-Stand
0.1.8. Gegenüber dem bisherigen Projekt wurden Projektname, Dokumentation und
Offline-Starter angepasst; die BLE-/Signalverarbeitungslogik bleibt unverändert.
Git-Historie, Laborwerkzeuge und echte Messaufzeichnungen sind nicht enthalten.

Lizenz: **MIT**, siehe [`LICENSE`](LICENSE). Sie erlaubt auch kommerzielle
Nutzung unter ihren Bedingungen. Die Lizenz räumt nur tatsächlich bestehende
und vom Lizenzgeber einräumbare Rechte ein; sie ersetzt weder eine medizinische
Freigabe noch Rechte Dritter an Messdaten. Die Lizenz des separaten
Firmware-Repositorys wird dadurch nicht geändert.
