# Bike-EKG_Web – Bedienung und Technik

Statische Browseroberfläche für den Nordic UART Service (NUS) des nRF52840.
Die Signalvorschau benötigt die passende
[nRF52840-Firmware](https://github.com/Tim-Porsch/Bike-EKG-nrf52840firmware);
MCU-Filterung für BLE ist ab 0.8.1 verfügbar.
Keine Installation von Python-BLE-Paketen, kein Buildschritt, keine externen
JavaScript-Bibliotheken. HTML, CSS und JavaScript im selben Ordner belassen.

## Starten

### Für die Weitergabe empfohlen: HTTPS

Den Inhalt dieses Ordners auf einem statischen HTTPS-Webhosting bereitstellen
(z. B. GitHub Pages). Die Nutzer öffnen den Link in einem unterstützten Browser.
Ein Backend ist nicht erforderlich. Das Hosting stellt nur die Dateien bereit;
die BLE-Kommunikation findet direkt zwischen Browser und Board statt.
Keine Daten werden von dieser Anwendung an das Hosting übertragen.

Im Footer stehen getrennt die **Webanwendungsversion** und die tatsächlich aus
`monitor.js` geladene **Steuerungs-JavaScript-Version** (aktuell jeweils **0.1.8**).
Diese Nummern sind unabhängig von der Gerätefirmware. Unterschiedliche Nummern
oder „nicht geladen“ weisen auf einen gemischten/fehlgeschlagenen Webstand hin.
Die eingebundenen CSS-/Skriptdateien besitzen einen Versionsparameter gegen alte
Browser-Caches. Bei Web-Releases `WEB_APP_VERSION` in `monitor.js`, die Footerangabe
und alle `?v=`-Parameter in `index.html` gemeinsam erhöhen und den ganzen Ordner
bereitstellen. Ein bereits gecachtes altes HTML wird dadurch nicht automatisch
ersetzt: Zum Prüfen die Seitenadresse einmal mit einem neuen Parameter öffnen,
z. B. `https://example.org/monitor/?reload=0.1.8` (bei vorhandenen Parametern `&reload=…`).

### Lokal

`index.html` kann direkt in Chrome/Edge geöffnet werden. Ob Bluetooth unter
`file://` verfügbar ist, hängt vom Browser und dessen Sicherheitsrichtlinien ab.
Diese Variante ist nicht als universeller Doppelklick-Starter garantiert.
Alle Dateien sind lokal; es werden keine Ressourcen aus dem Internet geladen.

Falls nötig, aus dem Projekt-Hauptordner (nicht aus `docs/`) einen lokalen
Webserver starten (Python 3 nötig):

```bash
python3 -m http.server 8000 --bind 127.0.0.1
```

Anschließend **http://localhost:8000** öffnen. `localhost` gilt als sicherer
Kontext. Eine unverschlüsselte LAN-Adresse wie `http://192.168.…` dagegen nicht.
Server mit `Ctrl+C` beenden. Für Windows lautet der Python-Aufruf ggf. `py -3`.

## Browser und Voraussetzungen

Fehlt Web Bluetooth oder wird die Seite außerhalb eines sicheren Kontexts
geöffnet, erscheint beim Start ein deutliches modales Hinweisfenster über der
gesamten Oberfläche. Es nennt Ursache und Abhilfe. **Verstanden** oder Escape
schließt den Hinweis; die lokale CSV-/BIN-Visualisierung bleibt nutzbar, die
BLE-Verbindung bleibt gesperrt. In sehr alten Browsern ohne Dialog-Unterstützung
wird stattdessen ein nativer Browserhinweis angezeigt.

| System | Empfehlung / Einschränkung |
| --- | --- |
| Windows, macOS | Aktueller Chrome oder Edge mit Web Bluetooth |
| Android | Chrome; Systemfreigaben für Bluetooth/Geräte in der Nähe ggf. erlauben |
| Linux | Chrome/Chromium; ggf. `chrome://flags/#enable-experimental-web-platform-features` aktivieren und Browser neu starten. Funktion auf dem Zielsystem prüfen. BlueZ und ein betriebsbereiter BLE-Adapter werden weiterhin benötigt. |
| Firefox, Safari | Web Bluetooth wird nicht unterstützt |
| iPhone/iPad | Nicht als unterstützte Standardplattform vorgesehen |

Bluetooth muss eingeschaltet sein. Browser-/Betriebssystemrichtlinien können
den Zugriff zusätzlich einschränken. Andere BLE-Tools vor dem Verbinden schließen.
Die Seite prüft sicheren Kontext und API-Verfügbarkeit; das ersetzt keinen
Hardwaretest auf dem jeweiligen Zielsystem.

## Bedienung

Unter dem Titel **Bike-EKG** lässt sich zwischen **EKG-Messystem** (Standardansicht) und
**Daten Visualisieren** wechseln. Der zweite Reiter öffnet den lokalen CSV-/BIN-Betrachter.
Der Wechsel lädt die Seite nicht neu: BLE-Verbindung, laufende Vorgänge und
Eingaben bleiben erhalten. Die Reiter lassen sich auch mit den Pfeiltasten
links/rechts sowie Pos1/Ende auswählen.

1. Board starten. Ab Firmware **0.12.5** wirbt es als **`Bike-EKG`**.
   Ältere Firmware mit dem Namen `Bike_EKG_Debug` wird weiterhin gefunden.
   Für den neuen Namen im Bluetooth-Auswahldialog muss die Firmware geflasht werden;
   bei gecachtem Gerätenamen ggf. die alte Browser-Geräteberechtigung entfernen
   und das Board erneut auswählen. Der separate Display-BLE-Name bleibt unverändert.
2. **Verbinden** anklicken und das Board im Browserdialog auswählen.
3. Standardmäßig wird nach dem Aktivieren der Notifications die PC-Unixzeit
   mit `time <seconds>` gesendet. Die Option kann vorher deaktiviert werden.
4. Die aktuelle Konfiguration wird nach jeder Verbindung automatisch mit
   `config` abgefragt. Bei ausbleibender oder abgebrochener Antwort wird dieser
   rein lesende Abruf einmal automatisch wiederholt. Erst nach einer vollständigen
   Antwort werden die Auswahl- und Zahlenfelder befüllt.
   Mit **Änderungen übernehmen** werden nur geänderte Werte gesendet. Vor dem
   nächsten Befehl wird jeweils die Firmwarebestätigung abgewartet; anschließend
   wird die Konfiguration erneut gelesen. Bei einem Fehler können vorherige
   Änderungen bereits gespeichert sein. Angezeigt wird nach dem erneuten Lesen
   der tatsächliche Gerätestand, nicht der ungeprüfte Formularinhalt.
5. SD-Aufzeichnung lässt sich im eigenen Bereich starten. Der Displaymodus besitzt
   keinen eigenen Bereich oder Button mehr; `display start` bleibt über die Konsole verfügbar.
   Zusätzliche Firmwarebefehle können weiterhin in der Konsole eingegeben werden.
   Antworten erscheinen unverändert. „Gesendet“ bestätigt nur die Übertragung,
   nicht die erfolgreiche Ausführung durch die Firmware.
6. **Trennen** beendet die Verbindung ohne automatische Wiederverbindung.

Hinter **Gerät:** wird außerdem die vom verbundenen Messsystem gemeldete
**Firmware-Version** angezeigt. Die angepasste Firmware ab **0.12.2** liefert sie
mit der automatisch geladenen Konfiguration. Alte Firmware ohne dieses Feld
bleibt nutzbar; angezeigt wird dann **Firmware: nicht gemeldet**. Die Versionsangabe
wird beim Verbindungsabbruch verworfen und nicht aus einer CSV-Datei übernommen.

Gerätesteuerung und Konsole sind nur bei bestehender Verbindung sichtbar.
Unter den Einstellungen setzt **Konfiguration zurücksetzen** nach einer
Sicherheitsabfrage mit `config reset` die Gerätekonfiguration auf Standardwerte
zurück. Erst nach der Gerätebestätigung wird die Konfiguration erneut geladen.
Der Button ist nur bei geladener Konfiguration im Leerlauf verfügbar, nicht
während Vorschau, Messung oder anderer laufender Geräteoperationen.
RLD und Vorschaufilter sind Checkbox-Schalter; Änderungen werden weiterhin erst
mit **Änderungen übernehmen** (unten rechts) übertragen. **Konfiguration
zurücksetzen** steht unten links. Die RLD-Sicherheitsabfrage bleibt erhalten.
Gerätebuttons (z. B. Vorschau starten/stoppen) fokussieren nicht automatisch die
Konsoleneingabe und öffnen damit auf Android keine Bildschirmtastatur. Nur nach
einem ausdrücklich in der Konsole abgesendeten Befehl wird deren Eingabefokus
ohne Scrollen wiederhergestellt.
Die Signalvorschau folgt direkt auf die Gerätesteuerung, danach kommt die eigene
Karte für die SD-Aufzeichnung.
**Versuchsperson** und **Kommentar** werden ab Firmware **0.10.0** beim Start
an den MCU übertragen und im 512-Byte-BIN-Header gespeichert. Beide Felder sind
optional; das Kürzel wird außen getrimmt, Kommentar-Zeilenenden werden auf LF
vereinheitlicht. Grenzen: 80 UTF-8-Bytes für die Versuchsperson, 376 für den
Kommentar. Die Anzeige zählt Bytes statt Zeichen (Umlaute/Emoji benötigen mehr
als ein Byte). Zu lange Texte werden nicht abgeschnitten: der Start wird abgewiesen.
Während der Aufzeichnung bleiben die Felder gesperrt; nach Ende bleiben ihre
Inhalte für eine weitere Messung erhalten, bis sie bearbeitet oder die Seite
neu geladen wird. Es erfolgt keine dauerhafte Browser-Speicherung.

Vor dem Start wird die vollständige Übertragung mit Prüfsumme bestätigt; nur ein
einmalig gültiger MCU-Token kann genau diese Metadaten für die Aufnahme übernehmen.
Teilübertragung, Timeout oder Disconnect lösen keinen automatischen Start aus.
Eine aktive Vorschau wird vor der Übertragung beendet. Bei alter Firmware wird
der Start verweigert statt die eingegebenen Angaben unbemerkt wegzulassen.
Der bestehende reine USB-/NUS-Befehl `start` bleibt unverändert und schreibt keine
Versuchsperson/Kommentare. Interne Übertragungs-/Startbefehle bleiben aus `help` heraus.
Nach bestätigtem Aufzeichnungsstart zeigt ein Fortschrittsbalken die aus der
eingestellten Dauer berechnete Lauf- und Restzeit. Die Anzeige ist eine Schätzung,
kein Nachweis gespeicherter Messdaten. Bei 100 % wird auf die Abschlussmeldung
der Firmware gewartet; ein vorzeitiger Stopp friert den Fortschritt ein.
Bei Verbindungsabbruch wird die Schätzung verworfen, nicht bei null fortgesetzt.
Dokumentation und Verbindungsbereich bleiben immer zugänglich. Während einer
laufenden Messung lässt die Firmware keine Konfigurationsabfrage zu. Dann bleiben
die Formularfelder gesperrt; eine SD-Aufzeichnung kann über **Stoppen** beendet
werden. **Konfiguration neu laden** ermöglicht eine erneute Abfrage.
Abtastrate, Verstärkung, Eingang, Dauer und Filterband speichert die Firmware
dauerhaft; ab **0.12.4** gilt dies auch für **RLD an/aus**. Der digitale Filter für
USB/BLE bleibt eine Laufzeiteinstellung und ist nach einem Neustart ausgeschaltet.

Standardkonfiguration ab Firmware **0.12.4** (ohne gültige gespeicherte Werte oder
nach **Konfiguration zurücksetzen**): **500 SPS, 6× Verstärkung, Messeingang,
300 s, RLD an, digitaler Filter aus**. Das Filterband bleibt bei 0,5–40 Hz.
RLD darf ausschließlich in elektrisch isolierten Prüfaufbauten verwendet werden;
Reset und RLD-Aktivierung weisen auf die dauerhafte Aktivierung hin.
Ein Firmwareupdate überschreibt vorhandene Einstellungen nicht. Alte Speicherformate
V1/V2 werden weiterhin gelesen, dabei bleibt RLD wie zuvor beim Booten **aus**.
Erst ein neuer Speichervorgang schreibt Format V3 inklusive RLD. Für die neuen
Standardwerte nach dem Update einmal **Konfiguration zurücksetzen** wählen.

Interne `chrome://`-Seiten dürfen aus einer normalen Webseite nicht zuverlässig
geöffnet werden. Im Browserhinweis steht deshalb zusätzlich **Adresse kopieren**
zur Verfügung. Die Adresse in einem neuen Tab in die Adresszeile einfügen,
„Experimental Web Platform features“ auf „Enabled“ setzen und Chromium neu starten.
Falls der Browser den Zwischenablagezugriff verweigert, wird die Adresse zum
manuellen Kopieren markiert. Die Freischaltung aktiviert auch andere experimentelle
Webfunktionen; sie ist keine Einstellung des Messsystems.

Bei einem unerwarteten Abbruch werden optional bis zu fünf Wiederverbindungen
mit wachsendem Abstand versucht. Danach erneut „Verbinden“ wählen.
Beim manuellen Trennen werden die Vorschau- und UART-Notifications zunächst
explizit abgemeldet, anschließend wird GATT getrennt. Ein neuer Verbindungsaufbau
wartet auf diesen Abschluss. Abmeldung und Disconnect-Ereignis haben jeweils
eine Zeitbegrenzung von 1,5 Sekunden, damit ein hängender Browseraufruf die
nächste Verbindung nicht dauerhaft blockiert.
Offene GATT-Verbindungsversuche können je nach Betriebssystem länger dauern.
Bereits gesendete Befehle werden **niemals automatisch wiederholt**.
Bei Übertragungsfehlern kann ein unvollständiger Befehl im MCU-Puffer liegen;
im Zweifel Board neu starten, bevor weitere Befehle gesendet werden.

Die Konsole hält die letzten 100.000 Zeichen im Arbeitsspeicher. **Text speichern**
lädt den aktuell sichtbaren Puffer als `.txt` herunter (kein vollständiger
Langzeitrekorder). Mit ↑/↓ lassen sich bis zu 100 zuletzt gesendete Befehle
aufrufen. Beim Neuladen gehen Puffer und Verlauf verloren.
Tab geöffnet und möglichst im Vordergrund lassen; Energiesparmodus oder
Hintergrunddrosselung können Verbindung/Wiederverbindung beeinflussen.

### Displaymodus und USB-Streaming

- `display start` erfordert vorher `rate 250`. Nach Bestätigung des Dialogs
  wird nur `display start` gesendet, keine Einstellung stillschweigend geändert.
- Die Firmware trennt NUS und wirbt dann als `Bike_EKG_Display`. Der Monitor
  versucht nach einem solchen Abbruch keine automatische Wiederverbindung.
  Nur eine empfangene `display: started`-Antwort gilt als Bestätigung; ein
  bloßer Verbindungsabbruch wird ausdrücklich als unbestätigt gemeldet.
- Bleibt die Verbindung bestehen, wird nach fünf Sekunden wieder die Konsole
  freigegeben. Die Antwort des Boards erklärt z. B. eine falsche Abtastrate.
- Im Displaymodus werden Konsolenbefehle ignoriert. Rückkehr durch Board-Neustart.
- Diese Anwendung empfängt nicht den separaten Display-BLE-Datenstrom.
- `stream start` gibt Messwerte über **USB-Serial**, nicht über NUS aus.

### Signalvorschau

Unter der Gerätesteuerung zeigt **Vorschau starten** standardmäßig die letzten zehn Sekunden als
ADC-Werte (Counts, keine kalibrierten mV). Die aktuelle Abtastrate
125/250/500 SPS wird übernommen. Die Y-Achse skaliert automatisch.
Über **Zeitfenster** lassen sich 5, 10, 20, 30 oder 60 Sekunden
auswählen, auch während der Vorschau. Dies bestimmt sowohl die Anzeige als auch
die Aufbewahrung im Browserpuffer. Beim Verkürzen werden ältere Werte verworfen;
beim Verlängern füllt sich das zusätzliche Fenster mit neuen Werten. Die Auswahl
bleibt bis zum Neuladen der Seite erhalten. Der Plot ist 420 Pixel hoch.
Messwerte werden über einen separaten binären BLE-Dienst empfangen und erscheinen
weder in der Konsole noch im exportierten Konsolentext.

**Digitaler Filter für Vorschau** ist zusammen mit den Grenzfrequenzen optisch
von den übrigen Einstellungen abgesetzt und aktiviert den vorhandenen
MCU-Bandpass mit dem eingestellten Filterband (weiterhin auch für USB-Streaming).
Änderungen übernehmen und danach
die Vorschau starten. Bei aktivem Filter werden bereits gefilterte Werte gesendet,
bei deaktiviertem Filter Rohwerte. Die Vorschau zeigt den tatsächlichen Modus aus
dem Firmwarestatus an. Bei Samplelücken wird der Filterzustand zurückgesetzt.
Die SD-Aufzeichnung bleibt ungefiltert; das Displayprotokoll bleibt unverändert.

- Vorschau ist nur im Leerlauf möglich. Zum Ändern der Konfiguration stoppen.
- Beim Start einer SD-Aufzeichnung wird die Vorschau zuerst beendet. Die Firmware
  verhindert auch unabhängig vom Browser gleichzeitige Vorschau und SD-Aufzeichnung.
- Beim Stoppen bleibt der letzte Verlauf stehen; bei Verbindungsabbruch wird er
  verworfen. Eine neue Verbindung startet die Vorschau nicht automatisch.
- Fehlende Sample-Nummern ergeben sichtbare Kurvenlücken. Unter dem Diagramm stehen
  empfangene und fehlende Samples seit Vorschau-Start; die Detailansicht enthält
  MCU-Erfassungsverluste, verworfene Sendewerte und erkannte Paketlücken.
  Diese Zähler überlappen teilweise und dürfen nicht pauschal addiert werden.
  Während des Empfangs ist die Verlustzahl vorläufig; der Endstatus berücksichtigt
  auch einen nicht empfangenen Datenrest.
- Eine begrenzte Sendewarteschlange verwirft bei Rückstau alte Frames. BLE-Durchsatz
  und Hintergrunddrosselung hängen von Browser, Adapter und Betriebssystem ab.
  Die Vorschau ist kein verlustfreier Rekorder und keine medizinische Auswertung.
- Alte Firmware ohne Vorschaudienst bleibt als Textkonsole nutzbar; ein Startversuch
  zeigt einen Hinweis. Nach dem Firmwareupdate ggf. Browser-Geräteberechtigung
  neu erteilen oder den BLE-Verbindungscache des Betriebssystems erneuern.

Die internen Steuerbefehle sind absichtlich nicht in der Firmware-`help` aufgeführt.
Das bestehende gefilterte Displayprotokoll bleibt unverändert.

### Darstellungsfilter im CSV-/SD-Betrachter

Der zunächst eingeklappte Bereich **Darstellungsfilter** enthält oben
**Bandpass & Notch**, darunter **QRS-Verstärkung**. **HP**, **LP** und **Notch** können einzeln aktiviert
und mit **Filter anwenden** auf die vollständige geladene Aufnahme angewendet
werden. Standardwerte: HP 0,5 Hz, LP 40 Hz, Notch 50 Hz mit Güte Q = 30.
Alle Filter sind zunächst aus. **Rohdaten anzeigen** entfernt die Filter exakt
aus der Darstellung, behält aber Häkchen und Parameter für erneutes Anwenden bei;
erneutes Anwenden beginnt immer mit den Originalwerten, nicht mit dem bereits
gefilterten Ergebnis. Zoomen verändert die Filterberechnung nicht.

HP/LP sind digitale Butterworth-IIR-Biquads zweiter Ordnung (−3 dB an der
Grenzfrequenz). Der Notch ist ein IIR-Biquad zweiter Ordnung; höheres Q macht die
Sperre schmaler. Verarbeitung kausal einmal vorwärts in der Reihenfolge
HP → LP → Notch, keine phasenfreie Vorwärts-/Rückwärtsfilterung. Deshalb sind
Phasenverschiebungen und Einschwingeffekte möglich, bei schmalen Notches nahe
Nyquist auch längeres Nachschwingen. An Datenlücken wird jedes Filter mit
konstanter Vorgeschichte neu initialisiert, ohne Werte über die Lücke hinweg
zu verwenden. Die Info-Bubble erläutert dies auch in der Oberfläche.

Optional folgt nach HP → LP → Notch eine Pan-Tompkins-ähnliche
**QRS-Verstärkung**: feste kausale 5-Punkt-Ableitung
`fs/8 * (x[n] + 2*x[n-1] - 2*x[n-3] - x[n-4])`, Quadrierung und kausaler
gleitender Mittelwert. Einziger zusätzlicher Parameter ist das Integrationsfenster
(1–1000 ms, Standard 150 ms). Die Fensterlänge wird auf die nächste ganze
Samplezahl gerundet, mindestens ein Sample; die tatsächliche Zahl steht in den
Ansichtsmetadaten. Ableitung mit konstanter Vorgeschichte und Integrator mit
Nullvorgeschichte werden an jeder Datenlücke zurückgesetzt. Ergebnis ist eine
QRS-Energiekurve in `(Counts/s)²`, kein normales EKG. Die Verzögerung der
Ableitung (zwei Samples) und des Mittelwerts wird nicht aus den Zeitstempeln
herausgerechnet. Es gibt keine adaptive Schwelle oder R-Zacken-Erkennung und
damit keine vollständige Pan-Tompkins-Auswertung. QRS lässt sich auch ohne
Bandpass aktivieren; verarbeitet werden nur die tatsächlich aktivierten Stufen.

Frequenzen müssen strikt zwischen 0 und der halben Abtastrate liegen, HP unter
LP, Q zwischen 1 und 100. Grundlage ist die gespeicherte oder vom CSV-Parser
geschätzte Abtastrate. Die Berechnung und der neue Min-/Max-Index laufen lokal
in einem Worker. Hauptplot, Übersicht, Cursor, Y-Skalierung und PNG nutzen die
gefilterten Werte; der PNG-Bericht nennt die angewendeten Filter. „Nur Plot“
blendet wie bisher alle Berichtsinformationen aus. Originaldatei, SHA-256-Prüfung
und CSV-Download bleiben unverändert. Während einer SD-Übertragung sind die
Filter gesperrt; eine neue Aufnahme startet ungefiltert. Kein medizinischer Filter.

### SD-Aufzeichnungen als CSV herunterladen

Nach einer erfolgreich auf SD abgeschlossenen Messung erscheint direkt im
Aufzeichnungsbereich **Messung visualisieren** mit dem bestätigten Dateinamen.
Damit wird genau diese Aufnahme in **Daten Visualisieren** übertragen, ohne
zuerst die SD-Dateiliste laden zu müssen. Das gilt auch für vorzeitig gestoppte,
korrekt abgeschlossene Aufnahmen. Bei SD-Fehlern oder fehlendem Dateinamen wird
der Knopf nicht angeboten; bei einer neuen Messung oder beim Trennen wird er
zurückgesetzt. Während anderer Geräteoperationen bleibt er gesperrt.

Für komprimierte Downloads Firmware **ab 0.12.0** flashen und nach dem Update neu verbinden (bei gecachten
GATT-Diensten ggf. Browser-/Betriebssystem-Verbindungscache erneuern). Der Bereich
**Aufzeichnungen auf SD-Karte** liegt zwischen Vorschau und Konsole.

1. Messung bzw. Vorschau stoppen und **Dateiliste laden** wählen.
2. Die scrollbare Liste zeigt alle `EKGxxxxx.BIN`-Aufzeichnungen im
   SD-Wurzelverzeichnis mit Dateigröße, Versuchsperson und Kommentar,
   neueste Dateinummer zuerst. Einträge erscheinen sofort einzeln, ohne auf das
   vollständige Listenende zu warten. Ab Firmware **0.12.2** kommen sie bereits
   vom Gerät in absteigender Dateinummernfolge: Zunächst werden kurz die Dateinamen
   erfasst, danach die Header von neu nach alt gelesen und übertragen.
   Ältere Firmware bleibt nutzbar: Empfangene Einträge werden laufend einsortiert,
   die tatsächlich neueste Datei erscheint dort jedoch möglicherweise erst später.
   **Abbrechen** stoppt das weitere Laden; bereits sichtbare Einträge bleiben
   erhalten und können dann heruntergeladen werden. Während des laufenden
   Listenabrufs sind Downloads gesperrt, weil die SD-Sitzung noch belegt ist.
   Bei einer Teilliste steht ausdrücklich „Dateiliste unvollständig“.
   Ältere Dateien ohne Metadaten werden entsprechend
   gekennzeichnet; sie bleiben les- und herunterladbar. Fehlerhafte Header werden
   als „Metadaten nicht lesbar“ angezeigt, ohne die Dateiliste abzubrechen.
3. **CSV herunterladen** liest die gewählte Datei als BLE-Notification-Datenstrom.
   Fortschritt, übertragene Größe und mittlere Geschwindigkeit werden angezeigt.
   Ab 0.12.0 komprimiert der MCU Messdatensätze verlustfrei beim Lesen; im Browser
   werden die ursprünglichen BIN-Bytes wiederhergestellt. Die Geschwindigkeitsanzeige
   bezieht sich auf diese Originalbytes pro Sekunde, nicht auf komprimierte Funkbytes.
4. Nach vollständigem Empfang vergleicht der Browser SHA-256 und Dateilänge mit
   den vom MCU aus den SD-Dateibytes ermittelten Werten. Nur bei Übereinstimmung
   prüft er zusätzlich das Aufzeichnungsformat und erstellt
   `EKGxxxxx.csv`. Der Download wird an die normale Browser-Downloadverwaltung
    übergeben; Zielordner und Rückfragen bestimmt die Browsereinstellung.
5. Alternativ öffnet **Visualisieren** direkt den Tab **Daten Visualisieren**.
   Die Gesamtzeitachse wird aus Dateigröße und gespeicherter Abtastrate bereits
   beim ersten Datenblock aufgespannt; das Signal zeichnet sich von links hinein,
   statt mit jedem Block zusammengestaucht zu werden. Bei größeren Zeitlücken
   wird die zunächst geschätzte Dauer bei Bedarf erweitert und am Ende mit den
   tatsächlichen Zeitstempeln abgeglichen. Zoom und Navigation bleiben nutzbar,
   **Gesamt** zeigt wieder die gesamte Zeitachse. Unter der Übersicht stehen
   Ladebalken, Prüfergebnis und **Übertragung abbrechen**.
   Bis zum erfolgreichen SHA-256- und Formatabgleich sind die Daten ausdrücklich
   vorläufig und der PNG-Export gesperrt. Bei Abbruch oder Fehler werden sie
   verworfen und eine zuvor geladene Ansicht wiederhergestellt. Bei Erfolg bleibt
   die vollständige Aufnahme zum Untersuchen und Exportieren geöffnet; es wird
   keine CSV automatisch heruntergeladen. Die Verarbeitung bleibt lokal.
   **CSV herunterladen** unter der Gesamtübersicht speichert bei Bedarf die
   erfolgreich geprüfte Aufnahme ohne erneute BLE-Übertragung. Fortschritt,
   Abbrechen und Prüfergebnis stehen nur im unteren Übertragungsbereich;
   oben bleiben Dateiname und Messinformationen.

CSV enthält zuerst kommentierte Metadatenzeilen (`# Schlüssel: JSON-Wert`), danach
`sample_number,timestamp_us,timestamp_s,adc_counts`. Messkonfiguration,
Firmwareversion, Gerätezeit (falls vorhanden), tatsächliche Dauer und
Verluststatistiken stammen aus der gespeicherten Datei – nicht aus den aktuellen
Einstellungen. Die Rohwerte bleiben unverändert, unabhängig vom Vorschaufilter.
`participant` und `comment` stammen aus der optionalen META-Erweiterung der
gespeicherten Datei; bei alten Dateien sind beide leer. Mehrzeilige Kommentare
werden in den kommentierten CSV-Metadatenzeilen JSON-escaped, sodass Tabellenzeilen
nicht beschädigt werden. Das Grundformat BEKG v1 mit 512-Byte-Header bleibt erhalten.
`transfer_verification`, `source_binary_sha256` und `source_binary_bytes` halten
den erfolgreichen Abgleich fest. Der SHA-256 bezieht sich auf die vollständige
ursprüngliche BIN-Datei (einschließlich Header und Footer), nicht auf die CSV.
`transfer_compression` ist `record_delta_v1`, wenn komprimierte Blöcke verwendet
wurden, andernfalls `none`. Auch die Abschlussmeldung zeigt diesen Unterschied.
Zeitstempelüberläufe werden für `timestamp_s` wie im bestehenden Parser aufgelöst.
CSV verwendet Komma als Spaltentrenner und Punkt als Dezimaltrennzeichen.

Während SD-Zugriff sind die übrigen Bedienelemente gesperrt. **Abbrechen** beendet
den Vorgang ohne Teil-CSV. Disconnect oder ein SD-Lesefehler bricht ebenfalls ab;
es gibt kein automatisches Fortsetzen. Dateiliste nach einer neuen Aufzeichnung
erneut laden. SD-Dateien werden weder gelöscht noch verändert.

Unvollständig abgeschlossene BIN-Dateien ohne gültigen Footer werden gelistet,
aber nicht als gültige CSV exportiert. Maximal 32 MiB pro BIN-Datei werden im
Browser gepuffert; das umfasst die aktuellen maximalen Aufzeichnungszeiten.
Die größere CSV benötigt zusätzlich Browser-RAM. Ein Backend ist nicht beteiligt.
Durchsatz hängt stark von ATT-MTU und Browser/Adapter ab; lange Aufzeichnungen
können entsprechend lange dauern. Tab im Vordergrund lassen. Maximal 4096 Bytes
sind unbestätigt unterwegs; der Browser bestätigt etwa alle 2048 Bytes. Einzelne
Pakete passen in die ausgehandelte ATT-MTU (roh bis 232 Nutzbytes pro Notification,
komprimiert bis 384 rekonstruierte Dateibytes; bei MTU 23 roh 8 Bytes).
CRC32 schützt Position, Sitzung und Übertragungsbytes; fehlende
oder beschädigte Abschnitte werden begrenzt erneut angefordert. Der abschließende
SHA-256-Abgleich verhindert einen Export bei abweichendem Gesamtinhalt. Kein
stiller Rückfall auf den alten ungeprüften Download; alte Firmware muss aktualisiert
werden. Die Abschlussmeldung zeigt auch die verwendete ATT-MTU zur Diagnose.
Firmware 0.11.0 bleibt nutzbar: Falls die Kompressionsoperation fehlt, öffnet der
Browser die Datei erneut und verwendet den weiterhin SHA-256-geprüften Rohstream.
Es gibt keinen Rückfall auf den alten Read-Download ohne Gesamtdateiprüfung.
Keine Binärdaten landen in der Textkonsole.

Kompression: Jeder Block enthält seinen ersten 12-Byte-Datensatz unverändert und
danach Differenzen für Probennummer, Zeitstempel und ADC-Bitmuster (ZigZag/LEB128).
Auch Lücken, Zeitstempelüberläufe und große ADC-Sprünge bleiben exakt erhalten.
Header und Footer werden unverändert übertragen. Nicht lohnende Blöcke und kleine
MTUs verwenden Rohpakete. Die SD-Datei und ihr Format ändern sich nicht; der MCU
benötigt nur einen festen 384-Byte-Eingabepuffer zusätzlich. Der reale Gewinn
hängt vom Signal ab und muss am Gerät gemessen werden.

Die Prüfung bestätigt den gleichen Byteinhalt bei dieser Übertragung. Sie erkennt
keine bereits vorher fehlerhaft auf SD gespeicherte Messung und ist keine Signatur
oder Authentifizierung des Geräts. Während des Downloads ist die SD-Datei exklusiv
read-only geöffnet; weder Aufzeichnung noch Dateiveränderungen sind erlaubt.

Technische Details und Hosttest: [SD_FILE_PROTOCOL.md](https://github.com/Tim-Porsch/Bike-EKG-nrf52840firmware/blob/main/Bike_ekg_nrf/SD_FILE_PROTOCOL.md).

**Sicherheit:** Kein medizinisches Überwachungsgerät. `rld on` ist im Projekt
nur für elektrisch isolierte Prüfaufbauten vorgesehen. Der Bestätigungsdialog
ist kein Ersatz für elektrische Schutzmaßnahmen.

## CSV- und BIN-Dateien ansehen

Im Reiter **Daten Visualisieren** eine CSV oder eine BIN-Aufzeichnung von der SD-Karte über **CSV-/BIN-Datei auswählen**
auswählen oder in das gestrichelte Feld ziehen. Die Datei bleibt lokal im Browser;
es gibt keinen Upload und keine dauerhafte Speicherung. Das Einlesen läuft in einem
Web Worker und kann abgebrochen werden. Dafür die Anwendung über **localhost oder
HTTPS** öffnen; unter `file://` können Browser das Starten des Workers verhindern.
BLE ist zum Ansehen nicht erforderlich; der Betrachter ist auch ohne Web Bluetooth nutzbar.

- Unterstützt wird die Bike-EKG-CSV mit kommentierten JSON-Metadaten und den Spalten
  `timestamp_s`, `adc_counts`, optional `sample_number` und weiteren Spalten.
  UTF-8, Komma als Trennzeichen, Dezimalpunkt. Maximal **256 MiB / 3 Millionen Messpunkte**.
- Außerdem werden abgeschlossene **Bike-EKG-BIN-Dateien (BEKG v1, maximal 32 MiB)**
  direkt unterstützt. Header, Footer, Dateigröße, Samplezahl und Zeitstempel werden
  vor der Anzeige geprüft. Dateiauswahl und Drag-and-drop funktionieren identisch.
  Nicht abgeschlossen gespeicherte, leere oder inkonsistente Aufnahmen werden
  abgewiesen; eine zuvor geladene Ansicht bleibt erhalten.
- Bei lokal geöffneten BIN-Dateien erscheint unten **CSV herunterladen**. Der Export
  verwendet die Originalbytes ohne BLE-Zugriff, mit gespeicherten Metadaten,
  vorzeichenbehafteten Rohwerten und aufgelösten Timestampüberläufen. Darstellungsfilter
  einschließlich QRS beeinflussen ihn nicht. Formatprüfung ist kein Integritätsnachweis:
  **Ein SHA-256-Abgleich mit der SD-Datei auf dem Gerät findet nicht statt.** Oberfläche
  und exportierte Metadaten kennzeichnen dies mit `transfer_verification: not_verified_local_file`;
  es wird keine SD-Prüfsumme erfunden.
- Zeit wird relativ zum ersten Messpunkt angezeigt. Die ursprünglichen Metadaten
  einschließlich Versuchsperson und Kommentar stehen unter **Datei- und Messinformationen**.
- Nach dem Öffnen zeigt das große Diagramm zunächst die ersten zehn Sekunden
  (bei kürzeren Dateien die ganze Aufnahme); die Übersicht zeigt immer alles.
- **Mausrad** zoomt um den Mauszeiger; **Ziehen** verschiebt den Zeitabschnitt.
  Schaltflächen wählen Gesamtansicht bzw. 5/10/30 Sekunden.
- Die **Übersicht** zeigt immer die gesamte Aufnahme. Auswahlfenster verschieben,
  an den beiden grünen Griffen vergrößern/verkleinern oder außerhalb klicken.
  Das Zeit-Auswahlband liegt direkt unter dem Diagramm.
- **Y-Achse automatisch** passt Min./Max. exakt an die sichtbaren Messpunkte an,
  mit etwas Rand. Das vertikale Auswahlband rechts begrenzt den Y-Bereich relativ
  zum Wertebereich der gesamten Aufnahme: obere/untere Griffe ändern die Grenzen,
  Ziehen im Band verschiebt beide Grenzen gemeinsam. Eine Änderung deaktiviert
  die Automatik; die manuelle Skalierung bleibt beim zeitlichen Verschieben erhalten.
  Über das **A mit Kreispfeilen** direkt über dem rechten Band lässt sich die
  Automatik jederzeit umschalten (grün = aktiv, grau = manuell).
- Der Zeiger zeigt den nächstgelegenen Messwert und dessen Zeit an. Fehlende
  Probennummern und auffällig große Zeitabstände werden als Lücken dargestellt,
  nicht interpoliert. Bei grober Darstellung bleibt die entsprechende Pixelspalte frei.
- Im fokussierten Diagramm: **←/→** verschieben, **+/−** zoomen, **Pos1** Gesamtansicht.
  Die Übersicht-Griffe lassen sich mit **←/→** bedienen; **Umschalt** vergrößert den Schritt.
  Die Y-Griffe lassen sich mit **↑/↓** bedienen. Touch: ein Finger verschiebt,
  zwei Finger zoomen; alternativ Zeit-Schaltflächen und Auswahlbänder.
  Messwerte am Zeiger stehen kompakt unter den Zeit-Schaltflächen; die Bedienhilfe ist dort über **i**
  aufklappbar (außerhalb klicken oder **Escape** schließt sie).

### Plot als PNG exportieren

**Plot exportieren** speichert den aktuellen Zeitabschnitt als PNG mit genau der gewählten
Y-Skalierung. Der Bericht enthält **Bike-EKG**, CSV-Dateinamen, Messbeginn (UTC),
Person, Abtastrate, Verstärkung, Eingang, RLD, Signalart und Firmware, soweit in
der CSV vorhanden. Fehlende Personenangaben erscheinen als `Person: -`, leere
Kommentare werden weggelassen. Datenlücken und gespeicherte Fehlerzähler werden
bei Auffälligkeiten ebenfalls aufgeführt.

Fehlt die gespeicherte Gerätezeit, steht beim Messbeginn ausdrücklich
**nicht im Messsystem gespeichert**. Das CSV-Exportdatum wird nicht als
Messdatum ausgegeben. Zeitfenster und Y-Grenzen stehen rechtsbündig unter dem Plot.

Bildschirm und Export verwenden denselben Bericht-Renderer. Das PNG wird mit
der gewählten **Export-Auflösung 1×, 2× oder 4×** neu gezeichnet (Standard: 4×).
Die Basis **1×** entspricht ungefähr der Pixelanzahl von Full HD (2,07 Megapixel),
behält aber das Seitenverhältnis des angezeigten Berichts bei. **2×** und **4×**
vervielfachen dessen Breite und Höhe entsprechend. Es werden keine weißen
Zusatzränder eingefügt und nichts verzerrt oder abgeschnitten.
Es wird nicht lediglich ein Bildschirmfoto vergrößert.
Dabei werden alle Messpunkte im sichtbaren Ausschnitt gezeichnet, ohne die
Min-/Max-Verdichtung der interaktiven Bildschirmansicht. Die Bildauflösung bleibt
endlich; die numerischen Originalwerte stehen weiterhin in der CSV.
Zeigerlinie, Bedienelemente, Info-Bubble und Zeit-/Y-Auswahlbänder sind nicht im PNG
enthalten. Lange Dateinamen und mehrzeilige Kommentare werden umgebrochen.
Dateiname des PNG: `<CSV-Name>_<Anfang>-<Ende>s.png`. Der Export erfolgt lokal,
ohne Serververarbeitung oder zusätzliche Bibliotheken.
Der Schalter **Nur Plot** rechts neben **Plot exportieren** lässt Titel,
Messinformationen und den Skalierungstext unter dem Diagramm im Export weg.
Achsen, Einheiten und Signal bleiben erhalten; die Browseransicht bleibt unverändert.

Die Darstellung nutzt Canvas ohne externe Bibliotheken. Ein Min-/Max-Blockindex
ermöglicht automatische Skalierung und eine spitzenerhaltende Pixelhüllkurve,
ohne bei jeder Interaktion die gesamte Aufnahme zu durchlaufen. CSV-Einlesen und
Indexaufbau erfolgen im Worker; Zahlenarrays werden ohne Kopie an die Ansicht übergeben.
Die tatsächliche Flüssigkeit hängt von Browser, Gerät und Dateigröße ab.
Ohne aktivierte Darstellungsfilter bleibt das Signal ungefiltert in ADC-Counts
(keine kalibrierten mV). Die optionalen Filter und die abweichende Einheit der
QRS-Energiekurve sind oben beschrieben. Kein medizinisches Auswertungswerkzeug.

## Technik und Tests

- NUS-Service: `6e400001-b5a3-f393-e0a9-e50e24dcca9e`
- TX (Notifications vom Board): `6e400003-b5a3-f393-e0a9-e50e24dcca9e`
- RX (Befehle zum Board): `6e400002-b5a3-f393-e0a9-e50e24dcca9e`
- Signalvorschau: siehe [PREVIEW_PROTOCOL.md](https://github.com/Tim-Porsch/Bike-EKG-nrf52840firmware/blob/main/Bike_ekg_nrf/PREVIEW_PROTOCOL.md).
- UTF-8, Befehlsabschluss `\n`, maximal 63 Befehlsbytes gemäß Firmwarepuffer.
- Sequenzielle Schreibvorgänge in maximal 20-Byte-Paketen; UTF-8-Decoder
  erhält seinen Zustand über mehrere Notifications hinweg.
- Firmware **0.12.3** puffert NUS-Antworten in einer festen 2048-Byte-Warteschlange.
  Bei vorübergehend vollem BLE-Sendepuffer bleiben ungesendete Bytes erhalten;
  pro `loop()`-Durchlauf wird höchstens ein Paket versucht. Ein fehlgeschlagener
  Versuch wird frühestens nach 20 ms erneut versucht (die Bluefruit-Schreibfunktion
  selbst kann bis zu 100 ms warten). Nach 2 s ohne Sendefortschritt, bei Disconnect
  oder deaktivierten Notifications wird der Rest verworfen. Ein Überlauf verwirft
  den Rückstau und meldet `error: console output overflow`. Keine unbegrenzte
  Warteschlange und keine Übernahme alter Antworten in die nächste BLE-Sitzung.
- `FirmwareClient` setzt Antwortzeilen aus Notifications zusammen, erkennt den
  vollständigen `config`-Block bis `apply:` und wartet auf Einstellungsbestätigungen.
  Nach sechs Sekunden ohne vollständige Antwort wird ausschließlich `config`
  einmal wiederholt, insgesamt also höchstens zwölf Sekunden gewartet. Alte
  Fragmente werden bis zum nächsten `config:`-Startmarker ignoriert. Fehlende und
  unvollständige Antworten werden unterschieden. Schreibbefehle, explizite
  Firmwarefehler, Transportfehler und abgebrochene Sitzungen lösen keinen Retry
  aus. Bei veränderter Firmwareausgabe sind Parser und Tests anzupassen.
- Die Formularvalidierung entspricht den Grenzen in `SettingsService`:
  Dauer 1–4200 s, Filterauflösung 0,001 Hz, obere Grenze maximal 65,535 Hz und
  kleiner als die halbe Abtastrate. Bei gleichzeitigem Ändern von Rate und Band
  wird die Reihenfolge so gewählt, dass auch die Zwischenkonfiguration gültig ist.
- Boardausgaben werden ausschließlich als Text dargestellt, nicht als HTML.

Automatisierte Transporttests ohne BLE-Hardware, mit Node.js 20.11+,
vom Projekt-Hauptordner aus:

```bash
node --test tests/*.test.cjs
```

Die Firmware-Hosttests für NUS-Sendestau, Defaults, RLD-Persistenz und Migration
gehören zum [Firmware-Repository](https://github.com/Tim-Porsch/Bike-EKG-nrf52840firmware).

Nach dem Flashen von 0.12.4 Defaults per Reset prüfen, danach RLD ausschalten,
übernehmen und neu starten (muss aus bleiben); mit eingeschaltetem RLD wiederholen.
Digitaler Vorschaufilter muss nach einem Neustart unabhängig davon aus sein.

Nach dem Update auf Firmware 0.12.3 und dem Bereitstellen des neuen Webmonitors
insbesondere unter Android Chrome mehrere Erstverbindungen mit und ohne
Zeitsynchronisierung testen. Die Antwort muss bis `apply: at next start` reichen.
Auch Vorschau, SD-Start/-Stopp und Wiederverbinden am Laptop prüfen. Der Web-Retry
bleibt mit Firmware 0.12.2 nutzbar, ersetzt aber nicht deren Sendepufferkorrektur.

Vor Weitergabe auf echter Hardware prüfen: Verbinden, `help`, lange Antwort
(`config`), Uhrzeit setzen, Trennen, Board-Ausfall/Wiederverbindung,
SD-Aufzeichnung starten/stoppen sowie Displaywechsel mit richtiger/falscher Rate.
Zusätzlich Vorschau bei allen drei Abtastraten, Signaländerungen, Verlustanzeigen,
Vorschau-Stopp, Verbindungsabbruch und Wechsel zur SD-Aufzeichnung prüfen.
SD-Liste bei leerer/fehlender Karte, CSV-Download, Abbruch, Verbindungsverlust und
bekannte Vergleichsdateien zusätzlich auf echter Hardware testen. Der SD-Dienst
ist wie NUS unverschlüsselt/offen konfiguriert; sensible Messdaten nur im
kontrollierten Prüfaufbau übertragen.

Referenzen: [MDN Web Bluetooth](https://developer.mozilla.org/en-US/docs/Web/API/Web_Bluetooth_API),
[Chrome-Dokumentation](https://developer.chrome.com/docs/capabilities/bluetooth).
