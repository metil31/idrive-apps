# Aplicații iDrive 7 România

O singură sursă MGU Store pentru **Sound Drive în română**, **Speed Limit România** și **HUD România**. Sound Drive Audio apare ca dependență pentru Sound Drive. Aplicațiile se aleg și se instalează separat din aceeași listă.

În MGU Store, adaugă `metil31/idrive-apps` și selectează ramura `mgu-romania`. Pentru afișarea limitei pe HUD și în instrumentar, Speed Limit România folosește `cluster-render` din [robertnisipeanu/idrive-apps](https://github.com/robertnisipeanu/idrive-apps).

Proiect comunitar independent pentru sisteme BMW compatibile.

## HUD România

Semnalizările și avariile, plus ora sosirii, timpul și distanța rămase dacă iDrive primește valori prin CarPlay. Cu mașina în READY, aplicația rulează în fundal. În Setări, poți muta cele două săgeți împreună pe orizontală și pe verticală și le poți apropia sau depărta. Poziția ETA se reglează separat.

Opțiunea **Melodie și artist din CarPlay**, activată implicit, afișează piesa redată pe iPhone dacă iDrive primește datele media. Titlul și artistul dispar la pauză sau deconectare. Semnalizările au prioritate și ascund temporar textul muzicii.

Necesită `cluster-render`. ETA pe Waze cu iPhone depinde de datele de traseu primite de la unitatea BMW. Pagina aplicației arată starea ghidajului, a metadatelor, a furnizorului CarPlay și numărul de destinații primite. Versiunea 0.1.1 este verificată cu semnale simulate. [Credite și licențe](projects/sound-drive/apps/hud_romania/NOTICE).

## Speed Limit România

În secțiunea HUD, dimensiunea semnului poate fi redusă până la 40 px. Pentru dimensiuni sub 64 px sunt disponibile treptele 40, 48 și 56 px.

## Surse și licențe

Fiecare aplicație folosește propriul kit de construire. Versiunile sunt actualizate aici prin importarea și verificarea surselor originale.

- **Sound Drive 1.0.9** și **Sound Drive Audio**, cod MIT. [Upstream Nico1003/sound-drive](https://github.com/Nico1003/sound-drive/tree/b7901d9abc2f69464def12278c81bb8023379224) · [Versiunea română la b42cd42](https://github.com/metil31/sound-drive-ro/tree/b42cd42e7407222bb2c723b74c0e4df31a24f87f) · [Licență](projects/sound-drive/LICENSE).
- **Speed Limit România 1.1.3**, cod GPL-3.0-or-later, cu notificările MIT ale componentelor preluate. [Upstream hexlay/idrive7-custom-apps](https://github.com/hexlay/idrive7-custom-apps) · [Baza versiunii române la 77b05b0](https://github.com/metil31/idrive7-speed-limit-romania/tree/77b05b0d6bf6aebda431770fd37e3dd2b7ecca1d) · [GPL](projects/speed-limit/LICENSE) · [MIT](projects/speed-limit/LICENSE.MIT).

Datele din harta offline sunt © [contributorii OpenStreetMap](https://www.openstreetmap.org/copyright), licența [ODbL](https://opendatacommons.org/licenses/odbl/1-0/). Baza de date completă este disponibilă ca [romania.pack](projects/speed-limit/apps/speed_limit/romania.pack), cu o [notificare inclusă în pachet](projects/speed-limit/apps/speed_limit/NOTICE). Pachetul folosește [extrasul România de la Geofabrik](https://download.geofabrik.de/europe/romania.html). Codul de generare a hărții este în [pack_sli.py](projects/speed-limit/kit/tools/pack_sli.py).

Harta 1.1.2 folosește datele din 24 noiembrie 2026 și corectează 13 segmente de pe Calea Victoriei la 30 km/h. [Lista segmentelor și sursa oficială](projects/speed-limit/kit/tools/romania-local-limits.json).

Atlasele de fonturi sunt distribuite cu licențele lor în directoarele `kit/runtime/fonts` și `kit/localization/fonts` din fiecare proiect.
