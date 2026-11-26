# Aplicații iDrive 7 România

O singură sursă MGU Store pentru **Metil's HUD Apps**, **Speed Limit Romania**, **Seat Comfort** și **Waze ETA iOS**. Adaugă `metil31/idrive-apps` și selectează ramura `mgu-romania`. Waze CarPlay Reader este dependența Waze ETA iOS. Aplicațiile cu suprapuneri folosesc [cluster-render](https://github.com/robertnisipeanu/idrive-apps).

Interfața pornește în engleză. Schimbă **Language → Romana** din meniul fiecărei aplicații. Interfața română folosește text fără diacritice.

## Metil's HUD Apps

Din 0.2.1, meniul deschide pagini separate pentru Media, semnalizări și ETA CarPlay nativ. ETA nativ folosește estimările trimise direct către iDrive de o aplicație compatibilă. Pentru Waze, aplicația separată **Waze ETA iOS** citește informațiile de pe ecranul CarPlay.

Semnalizările și avariile, ora sosirii dacă iDrive primește estimări CarPlay, plus titlul și artistul din CarPlay. Media apare pe HUD, pe harta activă din bord sau pe ambele, cu mărime și poziție separate. Coperta albumului este opțională și apare dacă sursa CarPlay furnizează imaginea pe unitate.

La actualizarea aplicației HUD, **Show song and artist** este oprit implicit. Dacă **Media HUD Romania** este deja instalată, dezactivează afișarea din aplicația veche înainte să activezi media în cea nouă. Reglajele media se fac în aplicația nouă. [Credite și licențe](projects/sound-drive/apps/hud_romania/NOTICE).

Cu mașina staționată, folosește demo-urile pentru semnalizări, ETA și media. Demo-ul se oprește la ieșirea din meniu, când mașina se mișcă sau după cel mult 90 de secunde. Pentru mostrele din cluster este necesară o hartă activă în bord.

## Speed Limit Romania

În secțiunea HUD, dimensiunea semnului poate fi redusă până la 40 px. Pentru dimensiuni sub 64 px sunt disponibile treptele 40, 48 și 56 px.

În secțiunea pentru bord, rândul „Bord” arată ce raportează `cluster-render` despre harta telefonului și un eventual panou de temă. Rândul este activ cu afișarea setată pe bord sau pe ambele ecrane.

Din versiunea 1.1.5, semnul urmează harta Maps on cluster când o temă o găzduiește în panoul de bord. Dimensiunea și poziția configurate pentru bord se adaptează la dreptunghiul hărții, iar semnul dispare când fluxul hărții se oprește.

Din 1.1.6, în secțiunea „Indicatoare de prioritate” poți activa avertizările offline pentru „Cedează trecerea” și „STOP”. Semnul de viteză se estompează, indicatorul de prioritate și distanța apar în același loc, apoi semnul de viteză revine. Demo-urile sunt disponibile cu mașina staționată și afișarea pe HUD activată. Poți regla poziția cu butoanele HUD existente, în pași de 10 px. Demo-ul durează cel mult 90 s și se oprește când ieși din meniu sau mașina începe să se miște.

Pentru proveniența datelor, sursele independente și metoda de verificare, vezi [verificarea limitelor și indicatoarelor](projects/speed-limit/VERIFICARE.md).

Versiunea 1.1.7 aplică limita documentată de 30 km/h pe două segmente din Strada Rondă, Sectorul 2. [Informarea ADP Sector 2](https://adp2.ro/wp-content/uploads/Informare-sensuri-unice-cvartal-4.pdf)

În 1.1.8, importul național acceptă și indicatoare STOP și Cedează marcate separat, cu sens explicit, precum și puncte fix la despărțirea unui drum cu sens unic în două segmente, când intrarea este unică și numele drumului se potrivește. Pachetul conține 19.739 de înregistrări de prioritate.

În 1.1.9, „Cedează trecerea” și „STOP” apar și pe harta activă din bord, inclusiv în temele care găzduiesc harta. Avertizările din bord au un comutator propriu, pornit implicit, și folosesc poziția și mărimea semnului de viteză configurate pentru bord. Demo-urile urmează afișajele selectate în aplicație.

În 1.2.0 sunt disponibile și demo-uri pentru semnul de limită și avertizarea de radar, pe afișajele selectate. Butoanele de poziție folosesc pași de 10 px și în bord.

## Seat Comfort

Aplicație separată pentru iDrive 7, cu setările direct pe prima pagină. Selectează scaunele din față, treapta și pragul exterior. Valori inițiale: 8 °C, treapta 2 și ambele scaune. Pornirea automată se activează din meniu.

Aplicația încearcă o singură activare per scaun după trecerea mașinii din starea oprită în READY, cât timp staționezi și temperatura este strict sub prag. Comanda are o durată de trei minute. Dacă oprești încălzirea manual, aplicația nu o pornește din nou în același ciclu.

Versiune experimentală pentru mașini cu traseu de încălzire frontală prin BDC_G05. Pentru fiecare scaun, aplicația verifică starea și repetă verificarea modulului separat la cel puțin 20 de secunde distanță înainte să trimită comanda. Dacă mașina nu confirmă un traseu compatibil, aplicația afișează rezultatul în meniu și lasă scaunul așa cum este. Încălzirea banchetei și ventilația apar ca indisponibile în această versiune. Traseul confirmat în simulare deservește scaunele din față. [Referință Heating Comfort](https://github.com/NamelsMissing/mgu-apps/tree/main/apps/g21_wheelheat).

## Waze ETA iOS

În 0.2.0, citirea pornește automat în starea READY când este activă cel puțin o opțiune de afișare. Lasă Waze în prim-plan pe ecranul central, cu un traseu activ. Ora sosirii, durata și distanța apar într-o pastilă pe HUD sau pe harta activă din bord, cu reglaje independente. După schimbarea ecranului, ultima estimare poate rămâne vizibilă până la două minute de la ultima captură validă.

Manevrele se activează separat pe HUD și pe hartă, cu propriile reglaje de poziție și mărime. În 0.2.1, pe lângă săgețile de stânga și dreapta, un sens giratoriu poate afișa numărul ieșirii într-un cerc, alături de distanță. Citirea este experimentală și confirmă o manevră nouă în două cadre. În 0.2.2, o captură ratată nu ascunde imediat o manevră recent confirmată. Manevra este retrasă la a doua citire ratată, la expirare, la ieșirea din CarPlay sau când se detectează o manevră diferită.

Fiecare afișaj are un demo propriu în meniu. Poți regla poziția și mărimea pentru ETA, stânga, dreapta și giratoriu cu Waze închis pe ecranul central. Demo-ul cere starea READY și viteză zero, iar pe cluster necesită harta activă în bord. Preselectarea benzilor este disponibilă ca mostră. Citirea ei din Waze necesită validarea pe cadre CarPlay care conțin ghidajul de benzi.

Texturile Waze se randează la 3×, iar cele pentru semnalizări, CarPlay ETA din Metil’s HUD Apps și semnele din Speed Limit Romania la 2×. Dimensiunile afișate și reglajele salvate sunt aceleași.

## Surse și licențe

Fiecare aplicație folosește propriul kit de construire. Versiunile sunt actualizate aici prin importarea și verificarea surselor originale.

- Codul arhivat pentru **Sound Drive** și **Sound Drive Audio**, MIT. [Upstream Nico1003/sound-drive](https://github.com/Nico1003/sound-drive/tree/b7901d9abc2f69464def12278c81bb8023379224) · [Versiunea română la b42cd42](https://github.com/metil31/sound-drive-ro/tree/b42cd42e7407222bb2c723b74c0e4df31a24f87f) · [Licență](projects/sound-drive/LICENSE).
- **Speed Limit Romania 1.2.0**, cod GPL-3.0-or-later, cu notificările MIT ale componentelor preluate. [Upstream hexlay/idrive7-custom-apps](https://github.com/hexlay/idrive7-custom-apps) · [Baza versiunii române la 77b05b0](https://github.com/metil31/idrive7-speed-limit-romania/tree/77b05b0d6bf6aebda431770fd37e3dd2b7ecca1d) · [GPL](projects/speed-limit/LICENSE) · [MIT](projects/speed-limit/LICENSE.MIT) · [Licența graficii indicatoarelor](projects/speed-limit/apps/speed_limit/NOTICE).

Datele din harta offline sunt © [contributorii OpenStreetMap](https://www.openstreetmap.org/copyright), licența [ODbL](https://opendatacommons.org/licenses/odbl/1-0/). Baza de date completă este disponibilă ca [romania.pack](projects/speed-limit/apps/speed_limit/romania.pack), cu o [notificare inclusă în pachet](projects/speed-limit/apps/speed_limit/NOTICE). Pachetul folosește [extrasul România de la Geofabrik](https://download.geofabrik.de/europe/romania.html). Codul de generare a hărții este în [pack_sli.py](projects/speed-limit/kit/tools/pack_sli.py).

Harta 1.1.2 folosește datele din 24 noiembrie 2026 și corectează 13 segmente de pe Calea Victoriei la 30 km/h. [Lista segmentelor și sursa oficială](projects/speed-limit/kit/tools/romania-local-limits.json).

Atlasele de fonturi sunt distribuite cu licențele lor în directoarele `kit/runtime/fonts` și `kit/localization/fonts` din fiecare proiect.
