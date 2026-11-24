# Aplicații iDrive 7 România

O singură sursă MGU Store pentru **Sound Drive în română** și **Speed Limit România**. Sound Drive Audio apare ca dependență pentru Sound Drive. Aplicațiile se aleg și se instalează separat din aceeași listă.

În MGU Store, adaugă `metil31/sound-drive-ro` și selectează ramura `mgu-romania`. Pentru afișarea limitei pe HUD și în instrumentar, Speed Limit România folosește `cluster-render` din [robertnisipeanu/idrive-apps](https://github.com/robertnisipeanu/idrive-apps).

## Surse și licențe

Fiecare aplicație folosește propriul kit de construire. Versiunile sunt actualizate aici prin importarea și verificarea surselor originale.

- **Sound Drive 1.0.9**, MIT. [Sursă la commitul b42cd42](https://github.com/metil31/sound-drive-ro/tree/b42cd42e7407222bb2c723b74c0e4df31a24f87f) · [Licență](projects/sound-drive/LICENSE).
- **Speed Limit România 1.1.1**, GPL-3.0-or-later, cu notificările MIT ale componentelor preluate. [Sursă la commitul aa5c974](https://github.com/metil31/idrive7-speed-limit-romania/tree/aa5c9748c3d3c22032a55051aa8c881cc337af49) · [GPL](projects/speed-limit/LICENSE) · [MIT](projects/speed-limit/LICENSE.MIT).

Datele din harta offline sunt © [contributorii OpenStreetMap](https://www.openstreetmap.org/copyright), licența [ODbL](https://opendatacommons.org/licenses/odbl/1-0/). Pachetul folosește [extrasul România de la Geofabrik](https://download.geofabrik.de/europe/romania.html). Codul de generare a hărții este în [pack_sli.py](projects/speed-limit/kit/tools/pack_sli.py).
