<h1 align="center">Sound Drive</h1>

<p align="center">
  <b>Virtueller Motorsound für BMW mit iDrive 7 (MGU) – über die eigenen Lautsprecher, gesteuert von
  echter Drehzahl und Last.</b><br>
  Entwickelt und im Alltag gefahren in einem BMW 220d (G42). Installierbar über den MGU Store.
</p>

<p align="center">
  <img alt="iDrive 7" src="https://img.shields.io/badge/BMW-iDrive%207%20MGU-e4002b?style=for-the-badge">
  <img alt="Ton im Auto" src="https://img.shields.io/badge/Ton%20im%20Auto-best%C3%A4tigt-2ea44f?style=for-the-badge">
  <img alt="MGU Store" src="https://img.shields.io/badge/Installation-MGU%20Store-1c6dd0?style=for-the-badge">
  <img alt="Lizenz MIT" src="https://img.shields.io/badge/Lizenz-MIT-8957e5?style=for-the-badge">
</p>

<p align="center">
  <img src="docs/screens/sound_drive.png" alt="Sound Drive: Drehzahl, Status des Tonwegs, Profilwahl und Lautstärke" width="100%">
</p>

> **Hinweis.** Inoffizielles Hobbyprojekt, nicht von der BMW AG unterstützt oder mit ihr verbunden.
> Änderungen am eigenen Head Unit erfolgen auf eigenes Risiko. Lautstärke vernünftig wählen, damit
> Warn- und Umgebungsgeräusche hörbar bleiben.

---

## Was Sound Drive macht

Sound Drive (früher „Iconix Sounds“) erzeugt live einen Motorsound und spielt ihn über die Fahrzeuglautsprecher ab – ähnlich
wie BMWs eigenes „Active Sound Design“, aber mit wählbarem Charakter. Grundlage sind die echten
Fahrzeugdaten: Drehzahl, Motormoment (Last) und Geschwindigkeit. Gibst du Gas, wird der Sound voller;
beim Gleiten bleibt er dezent im Hintergrund, im Schub blubbert er leise aus.

- **Klingt wie im Innenraum, nicht wie ein Synthesizer.** Jeder Zylinder erzeugt pro Zündung einen
  Abgas-Druckimpuls (echte Zündfolge), der durch eine nachgebildete Auspuffanlage läuft: Krümmer,
  Hauptrohr, Schalldämpfer. Dazu kommt Körperschall über Motorlager und Karosserie. Die Karosserie
  dämpft die Höhen – so wie man einen Motor im Auto wirklich hört.
- **Keine schrillen Töne, keine Knackser, kein Rauschen.** Kein Pfeifen, keine Patscher, kein
  Ansaugrauschen, kein Zischen. Prüfwerkzeuge im Repository messen das automatisch.
- **Oben im Drehzahlband lauter,** wie ein echter Motor – auch bei Teillast.
- **Folgt dem Fahrmodus:** In Eco Pro dezent und dumpfer, in Comfort normal, in Sport lauter, offener und
  bellender, in Sport+ noch etwas mehr. Der Wechsel geht weich über etwa eine Sekunde.
- **Lauter bei hohem Tempo:** ab 50 km/h steigt der Sound sanft an, bei 130 km/h um +2, +4 oder +6 dB (einstellbar),
  damit er gegen Wind- und Abrollgeräusche ankommt.
- **Startsound:** Beim Motorstart dreht der Starter kurz durch, der Motor springt an, dreht hoch und fällt auf
  Leerlauf – passend zum gewählten Profil (abschaltbar).
- **Startet von selbst** mit dem Auto und läuft im Hintergrund – die App muss nicht geöffnet werden. Wann, bestimmt das
  Head Unit (nach einem Kaltstart rund 55 Sekunden nach dem Einschalten); die Audio-Diagnose zeigt die Zeiten. Schont das Head Unit
  (Klangberechnung direkt in 24 kHz, wenige Millisekunden Rechenzeit pro Sekunde Ton).

### Die Profile

| Profil | Charakter |
|---|---|
| **Power Four** (Standard) | Kräftiger Vierzylinder, auf das schmale Drehzahlband eines Diesels abgestimmt: oben satt statt dünn. |
| **Supra** | Reihensechser im Supra-Stil: seidig und rauchig, dreht frei hoch. |
| **Flat Four** | Vierzylinder-Boxer: Ungleich lange Krümmer je Seite geben das bekannte Grummeln. |
| **Flat Six** | Sechszylinder-Boxer: kehlig und sonor, dreht frei hoch. |
| **Rally Five** | Fünfzylinder: Die ungerade Zündfolge gibt das typische Trällern, rau und kehlig. |
| **Muscle V8** | Cross-Plane-V8 mit dem typischen ungleichmäßigen Blubbern. |
| **Track V10** | Voller, dichter Zehnzylinder. |
| **Grand V12** | Seidig und mächtig, singt oben heraus. |

Street Four und Sport Four sind seit Version 1.0.6 im neuen Power Four aufgegangen (eine gespeicherte Auswahl wird
umgestellt).

**Hörproben** (so, wie sie im Auto ankommen: 24 kHz mono; Leerlauf, Vollgas bis 4800 U/min, Schub,
Konstantfahrt, Teillast):
[Power Four](docs/audio/sounddrive_power_four.wav) ·
[Supra](docs/audio/sounddrive_supra.wav) ·
[Flat Four](docs/audio/sounddrive_flat_four.wav) ·
[Flat Six](docs/audio/sounddrive_flat_six.wav) ·
[Rally Five](docs/audio/sounddrive_turbo5.wav) ·
[Grand V12](docs/audio/sounddrive_v12.wav)

### Bedienung und Einstellungen

- Profil und Lautstärke per Antippen wählen (den Lautstärke-Regler auch antippen oder ziehen) – große Knöpfe, zwei je Reihe, gut während der Fahrt zu treffen; der
  iDrive-Knopf und die Lautstärkeregelung des Autos bleiben unangetastet
- Lautstärke 0–100 % (100 % ist so laut wie früher 150 %: leise Passagen deutlich lauter, Spitzen begrenzt), **Ausprägung** (wie stark der Sound mit der Last aufmacht), Sport-Boost, stumm im Stand
- **Sound folgt dem Fahrmodus** (abschaltbar); die Seite nutzt die ganze Breite (**Schmale Ansicht** lässt Platz für
  das Seitenfenster der geteilten Ansicht). Reiter **Sound** im Kopf führt aus den Einstellungen zurück
- **Lautstärkeknopf regelt die Musik** (Standard): Das Auto behandelt den Motorsound wie eine Durchsage – solange
  er läuft, würde der Knopf ihn statt der Musik verstellen. Dreht man am Knopf, tritt der Motorsound kurz zur Seite
  (weich aus, Kanal frei), der Knopf regelt die Musik. Knapp 1 s nach dem letzten Drehen verbindet Sound Drive wieder (wer weiterdreht, verlängert die Pause);
  hörbar ist der Sound, sobald das Auto die Verbindung freigibt (meist 1–2 Sekunden). Ganz ohne Pause geht es nicht:
  Solange der Kanal verbunden ist, gehört der Knopf ihm – auch bei anderen Projekten. Ansagen zählen nicht als Drehen. Dass das Auto beim Verbinden und
  Trennen die Lautstärke selbst umstellt, zählt nicht als Drehen (sonst entstünde eine Schleife). Ausgeschaltet
  verhält es sich wie im Auto vorgesehen (der Knopf regelt den Motorsound).
- **Bei Telefon/Ansagen leiser:** Telefonate, Sprachassistent, Parkpiepser und Warngongs senken den Motorsound um
  etwa 12 dB ab; Navigationsansagen bewusst nicht
- **Klang anpassen:** Bass (Dröhnen) ±6 dB und Auspuff-Bellen 50–150 % (wie weit Schalldämpfer und Innenraum
  öffnen) – für jedes Profil
- **Motor anpassen:** Leerlauf- und Abregeldrehzahl sowie maximales Drehmoment des eigenen Motors – der Sound
  bildet das echte Drehzahlband auf das Profil ab
- **Experten:** Tonweg, Ausgabegerät und Lastquelle (zum Ausprobieren in anderen Autos)
- **Testsound:** 9 Sekunden Leerlauf → Vollgas → Schub, auch im Stand
- **Audio-Diagnose** direkt in der App: Verbindung zum Audiomanager, Quellen, Senken, SmartX-Kanäle, Vorlauf und
  Aussetzer, Grund fürs Absenken
- **QR log** in den Einstellungen: das Log als QR-Codes zum Abfotografieren (für ein Issue ohne SSH)

### So kommt der Ton in die Lautsprecher

Store-Apps haben keine Audio-Schnittstelle. Deshalb erzeugt das Tool **Sound Drive Audio** (ein kleiner
Dienst auf dem Head Unit) den Sound und schreibt ihn in einen Audiokanal des BMW-Systems (SmartX). Die
App bittet den BMW-Audiomanager, diesen Kanal mit den Lautsprechern zu verbinden – nur solange Ton
gebraucht wird.

Der **Tonweg** ist in den Einstellungen unter „Experten“ wählbar. Standard ist der **Overlay-Mix**: Der Motorsound
liegt über der Musik, die weiterläuft. Weitere Wege (CarLife exklusiv, CarLife-Navi, MainSink,
CarPlay-Kanal, ALSA direkt) sind zum Ausprobieren in anderen Autos und Ausstattungen gedacht.

Die Verbindung im Audiomanager braucht im Auto rund 6 Sekunden, bis sie hörbar ist. Darum baut Sound Drive sie schon
auf, wenn das Auto aufwacht, und hält sie, solange der Motor läuft – so kommt der Ton beim Anlassen sofort. Bis die
Verbindung steht (oder wenn eine CarPlay-Ansage sie kurz übernimmt), bleibt der Sound leise und blendet danach weich
ein, statt abgehackt einzusetzen. Der Player läuft mit Echtzeit-Priorität, damit er auch auf einem ausgelasteten
Head Unit nicht zu spät kommt (sonst knistert es).

Der Overlay-Kanal ist mono. Ein räumlicher Klang (Auspuff hinten, Motor vorne) würde zwei getrennte Kanäle
auf Front- und Hecklautsprecher brauchen; das gibt der Audiomanager bisher nicht her.

---

## Installation

Voraussetzung ist ein iDrive 7 (MGU) mit Root-Zugang und installiertem
[MGU Store](https://github.com/robertnisipeanu/mgu-store).

1. Im MGU Store dieses Repository als Quelle hinzufügen: `Nico1003/sound-drive`
2. **Sound Drive** installieren. Das Tool **Sound Drive Audio** kommt als Abhängigkeit automatisch mit.
   (Wer „Iconix Sounds“ schon hat, bekommt den neuen Namen einfach als Update.)
3. App öffnen, **Testsound** drücken – fertig. Updates kommen über den Store.

Klappt es nicht auf Anhieb: In der Statuszeile sollte „Overlay-Mix: verbunden“ stehen. Wenn nicht,
**Audio-Diagnose** öffnen, ein Foto machen, den nächsten **Tonweg** probieren und gern ein
[Issue](https://github.com/Nico1003/sound-drive/issues) mit dem Foto anlegen.

| Komponente | Version |
|---|---|
| Sound Drive (App) | 1.0.8 |
| Sound Drive Audio (Tool) | 1.0.8 |

---

## Außerdem: Fahrstil-Coach

<p align="center">
  <img src="docs/screens/drive_coach.png" alt="Fahrstil-Coach: Live-Seite mit Wertungsring, Wasserglas, Tipp und Kategorien" width="100%">
</p>

Die zweite App in diesem Repository (Version 1.0.3) bewertet jede Fahrt live und im Rückblick, ähnlich
einem Fahrlehrer auf dem Beifahrersitz:

- **Wertung von 0 bis 100** aus sieben Kategorien: Vorausschau, Beschleunigen, Kurven, Ruhe,
  Drehzahl, Motorschonung und Leerlauf
- **Wasserglas,** das mit den echten Längs- und Querkräften schwappt und bei ruppiger Fahrweise
  verschüttet
- **Live-Tipps** (kalter Motor, Drehzahl, Turbo abkühlen lassen), **Verlauf** mit Wochenvergleich,
  **Level und 15 Abzeichen**
- Coach-Modus Eco, Ausgewogen oder Sportlich – „Auto“ folgt dem Fahrerlebnisschalter
- Läuft im Hintergrund und erkennt Fahrtbeginn und -ende selbst

<table>
  <tr>
    <td><img src="docs/screens/drive_coach_trip.png" alt="Fahrstil-Coach: Auswertung der Fahrt"></td>
    <td><img src="docs/screens/drive_coach_history.png" alt="Fahrstil-Coach: Verlauf"></td>
  </tr>
  <tr>
    <td align="center"><sub>Fahrt: Kategorien, Ereignisse, Kennzahlen</sub></td>
    <td align="center"><sub>Verlauf: Wertung der letzten Fahrten</sub></td>
  </tr>
</table>

---

## Für Entwickler

| Pfad | Inhalt |
|---|---|
| `apps/iconix_sounds/` | Sound Drive: `main.js`, `ui.js`, `car_route.js` (Audiomanager), `synth.js` + `profiles.js` (Klang) |
| `tools/iconix-audiod/` | Audio-Dienst: Synthese und Ausgabe über SmartX/ALSA (`engine.js`, `alsa_play.py`) |
| `apps/drive_coach/` | Fahrstil-Coach: `coach.js` (Bewertung), `goals.js` (Level, Abzeichen), `main.js` |
| `kit/runtime/` | Laufzeit des Kits (Bildschirm, Signale, Einstellungen), wird in jede App gepackt |
| `kit/tools/` | `build.py` (baut die App auf dem Head Unit), Tests und Klang-Werkzeuge |
| `mgu-repo.json` | was der MGU Store aus diesem Repository anbietet |

Alles läuft mit Node, ohne Auto:

```bash
node kit/tools/test_iconix_route.js
```

```bash
node kit/tools/iconix_calibrate.js --wav docs/sounds --rate 24000
```

```bash
node kit/tools/iconix_popscan.js
```

```bash
node kit/tools/test_drive_coach.js
```

```bash
python3 kit/tools/test_alsa_play.py
```

```bash
node kit/tools/test_engine_e2e.js
```

```bash
node kit/tools/test_daemon.js
```

```bash
node kit/tools/iconix_soak.js
```

Dieselben Prüfungen laufen bei jedem Push als GitHub-Action (`.github/workflows/app-tests.yml`).

`test_iconix_route.js` prüft Tonweg, Umrechnung und Klang (keine Höhen, keine Knackser, kaum
Rauschen); `iconix_calibrate.js` misst Pegel und Klangbild je Profil und schreibt Hörproben;
`iconix_popscan.js` sucht in einer Fahrt mit Schaltvorgängen nach Knacksern; `test_alsa_play.py` prüft den
Python-Player mit einer simulierten Soundkarte; `test_engine_e2e.js` startet den Dienst mit echtem Player-Prozess und
misst die Verzögerung; `test_daemon.js` startet den ganzen Dienst als Prozess und spricht ihn über seinen Socket an
(wie die App); `iconix_soak.js` fährt jedes Profil in jedem Fahrmodus und jeder Lautstärke durch alle
Fahrsituationen (Kaltstart mit Startsound, Schalten, Kickdown, Schub, Telefon, Profil- und Moduswechsel, Stumm,
Datenlücke, Extremwerte, Abwürgen), auch mit den Klang-Reglern in beiden Extremen, und prüft auf NaN, Übersteuern,
Knacken und Stille.

Der Klang folgt dem physikalisch informierten Ansatz von Baldan et al. (2015, „Physically informed car
engine sound synthesis“) und den offenen Projekten
[engine-sound-lab](https://github.com/geoffmyers/engine-sound-lab) und
[ice-engine-simulator](https://github.com/daveruiz/ice-engine-simulator) (Ideen und Größenordnungen,
kein übernommener Code).

Die Apps basieren auf dem Kit aus
[cauliflowermossgrape/idrive7-apps](https://github.com/cauliflowermossgrape/idrive7-apps); dieses
Repository enthält nur den Teil, den die beiden Apps brauchen. Doku zum Kit:
[Originalprojekt](https://github.com/cauliflowermossgrape/idrive7-apps#readme) (englisch).

---

## Danksagung

- [cauliflowermossgrape/idrive7-apps](https://github.com/cauliflowermossgrape/idrive7-apps):
  Kit, Laufzeit und Build
- [Robert Nisipeanu / MGU Store](https://github.com/robertnisipeanu/mgu-store): Store und Renderer
- Der Audiomanager-Weg folgt dem, was Moonride (JustAnotherPU),
  [M850i-amn/idrive7-apps](https://github.com/M850i-amn/idrive7-apps) und
  [loenne007/idrive-enginesound](https://github.com/loenne007/idrive-enginesound) dokumentiert haben; von dort
  stammt auch die Beobachtung, dass der Lautstärkeknopf bei der Haupt-Senke sichtbar ist und das Auto die Quelle wie
  eine Durchsage behandelt (eigene Umsetzung, kein übernommener Code)

## Lizenz

[MIT](LICENSE), wie das Kit des Originalprojekts.
