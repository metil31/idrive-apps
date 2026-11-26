# Aplicații iDrive 7 România

O singură sursă MGU Store pentru **Sound Drive în română**, **Speed Limit România**, **HUD România**, **Media HUD România**, **Scaune calde** și testul **Waze ETA**. Sound Drive Audio apare ca dependență pentru Sound Drive. Aplicațiile se aleg și se instalează separat din aceeași listă.

În MGU Store, adaugă `metil31/idrive-apps` și selectează ramura `mgu-romania`. Pentru afișarea limitei pe HUD și în instrumentar, Speed Limit România folosește `cluster-render` din [robertnisipeanu/idrive-apps](https://github.com/robertnisipeanu/idrive-apps).

Proiect comunitar independent pentru sisteme BMW compatibile.

## HUD România

Semnalizările și avariile, plus ora sosirii, timpul și distanța rămase dacă iDrive primește valori prin CarPlay. Cu mașina în READY, aplicația rulează în fundal. În Setări, poți muta cele două săgeți împreună pe orizontală și pe verticală și le poți apropia sau depărta. Poziția ETA se reglează separat.

Necesită `cluster-render`. ETA pe Waze cu iPhone depinde de datele de traseu primite de la unitatea BMW. Pagina aplicației arată starea ghidajului, a metadatelor, a furnizorului CarPlay și numărul de destinații primite. [Credite și licențe](projects/sound-drive/apps/hud_romania/NOTICE).

HUD România afișează ETA din actualizările primite după confirmarea traseului CarPlay. Ascunde estimarea când ghidajul se oprește, sursa își pierde confirmarea sau actualizările expiră.

## Media HUD România

Aplicație separată pentru melodia și artistul din CarPlay. În Setări poți muta textul pe orizontală și verticală. Implicit apare sub poziția de jos a ETA. Se ascunde la pauză sau când se deconectează sursa CarPlay. Pentru a trece de la afișarea integrată în HUD România 0.1.1 la aplicația separată, actualizează mai întâi HUD România la 0.1.2. [Credite și licențe](projects/sound-drive/apps/media_hud_ro/NOTICE).

Din versiunea 0.1.1 poți alege HUD, bord sau ambele. Mărimea și poziția se reglează separat. Pe bord, textul urmează harta activă Maps on cluster, inclusiv în tema care o găzduiește. Opțiunea **Coperta albumului** este dezactivată implicit și citește imaginea JPEG locală dacă iDrive o furnizează pentru piesa curentă.

Din versiunea 0.1.5, aplicația se deschide direct în meniul de reglaje. Butoanele stânga, dreapta, sus și jos mută afișajul cu 10 px la fiecare apăsare, iar mărimea se schimbă cu un cursor în aceeași pagină.

Textul lung este scurtat cu puncte de suspensie. La mărimea maximă, grupul cu titlul, artistul și coperta ocupă cel mult 300 px pe HUD și 375 px pe harta standard din bord. Pe bord, grupul apare pe o pastilă gri-negru semitransparentă. Imaginea din bord este generată la rezoluție dublă și redimensionată cu interpolare biliniară.

## Speed Limit România

În secțiunea HUD, dimensiunea semnului poate fi redusă până la 40 px. Pentru dimensiuni sub 64 px sunt disponibile treptele 40, 48 și 56 px.

În secțiunea pentru bord, rândul „Bord” arată ce raportează `cluster-render` despre harta telefonului și un eventual panou de temă. Rândul este activ cu afișarea setată pe bord sau pe ambele ecrane.

Din versiunea 1.1.5, semnul urmează harta Maps on cluster când o temă o găzduiește în panoul de bord. Dimensiunea și poziția configurate pentru bord se adaptează la dreptunghiul hărții, iar semnul dispare când fluxul hărții se oprește.

Din 1.1.6, în secțiunea „Indicatoare de prioritate pe HUD” poți activa avertizările offline pentru „Cedează trecerea” și „STOP”. Semnul de viteză se estompează, indicatorul de prioritate și distanța apar în același loc, apoi semnul de viteză revine. Demo-urile sunt disponibile cu mașina staționată și afișarea pe HUD activată. Poți regla poziția cu butoanele HUD existente, în pași de 10 px. Demo-ul durează cel mult 90 s și se oprește când ieși din meniu sau mașina începe să se miște.

Pentru proveniența datelor, sursele independente și metoda de verificare, vezi [verificarea limitelor și indicatoarelor](projects/speed-limit/VERIFICARE.md).

Versiunea 1.1.7 aplică limita documentată de 30 km/h pe două segmente din Strada Rondă, Sectorul 2. [Informarea ADP Sector 2](https://adp2.ro/wp-content/uploads/Informare-sensuri-unice-cvartal-4.pdf)

În 1.1.8, importul național acceptă și indicatoare STOP și Cedează marcate separat, cu sens explicit, precum și puncte fix la despărțirea unui drum cu sens unic în două segmente, când intrarea este unică și numele drumului se potrivește. Pachetul conține 19.739 de înregistrări de prioritate.

## Scaune calde

Aplicație separată pentru iDrive 7, cu setările direct pe prima pagină. Selectează scaunele din față, treapta și pragul exterior. Valori inițiale: 8 °C, treapta 2 și ambele scaune. Pornirea automată se activează din meniu.

Aplicația încearcă o singură activare per scaun după trecerea mașinii din starea oprită în READY, cât timp staționezi și temperatura este strict sub prag. Comanda are o durată de trei minute. Dacă oprești încălzirea manual, aplicația nu o pornește din nou în același ciclu.

Versiune experimentală pentru mașini cu traseu de încălzire frontală prin BDC_G05. Pentru fiecare scaun, aplicația verifică starea și repetă verificarea modulului separat la cel puțin 20 de secunde distanță înainte să trimită comanda. Dacă mașina nu confirmă un traseu compatibil, aplicația afișează rezultatul în meniu și lasă scaunul așa cum este. Verificată în simulare. [Referință Heating Comfort](https://github.com/NamelsMissing/mgu-apps/tree/main/apps/g21_wheelheat).

## Waze ETA

Aplicație separată, experimentală. Cu mașina staționată, deschide **Waze ETA**, pornește testul și revino în Waze cu un traseu activ. La pornire ai 45 de secunde pentru probă dacă starea ecranului CarPlay încă nu a fost primită. Apoi capturile continuă numai când iDrive anunță că interfața CarPlay este în prim-plan. Recunoașterea are nevoie de două capturi consecutive pentru a confirma o valoare nouă. Versiunea de test a fost verificată pe capturi furnizate de utilizator, cu interfața Waze în engleză.

Aplicația afișează starea și valorile în meniu. Dacă activezi **Arată ETA pe HUD**, apare un card reglabil cu ora sosirii, timpul și distanța rămase. La schimbarea ecranului, ultima valoare este marcată **MEMORAT** și expiră după două minute de la ultima citire validă. Testul se oprește după 30 de minute sau imediat de la comanda **Oprește testul**. Serviciul folosește imagini temporare în memorie. Cardul nu ocupă zona hărții din ceasuri.

Citirea pe un iDrive real și vizibilitatea pe HUD trebuie confirmate pe mașină. [Referință pentru captura locală](https://github.com/Impossible43/vlad-mgu-apps).

## Surse și licențe

Fiecare aplicație folosește propriul kit de construire. Versiunile sunt actualizate aici prin importarea și verificarea surselor originale.

- **Sound Drive 1.0.9** și **Sound Drive Audio**, cod MIT. [Upstream Nico1003/sound-drive](https://github.com/Nico1003/sound-drive/tree/b7901d9abc2f69464def12278c81bb8023379224) · [Versiunea română la b42cd42](https://github.com/metil31/sound-drive-ro/tree/b42cd42e7407222bb2c723b74c0e4df31a24f87f) · [Licență](projects/sound-drive/LICENSE).
- **Speed Limit România 1.1.8**, cod GPL-3.0-or-later, cu notificările MIT ale componentelor preluate. [Upstream hexlay/idrive7-custom-apps](https://github.com/hexlay/idrive7-custom-apps) · [Baza versiunii române la 77b05b0](https://github.com/metil31/idrive7-speed-limit-romania/tree/77b05b0d6bf6aebda431770fd37e3dd2b7ecca1d) · [GPL](projects/speed-limit/LICENSE) · [MIT](projects/speed-limit/LICENSE.MIT) · [Licența graficii indicatoarelor](projects/speed-limit/apps/speed_limit/NOTICE).

Datele din harta offline sunt © [contributorii OpenStreetMap](https://www.openstreetmap.org/copyright), licența [ODbL](https://opendatacommons.org/licenses/odbl/1-0/). Baza de date completă este disponibilă ca [romania.pack](projects/speed-limit/apps/speed_limit/romania.pack), cu o [notificare inclusă în pachet](projects/speed-limit/apps/speed_limit/NOTICE). Pachetul folosește [extrasul România de la Geofabrik](https://download.geofabrik.de/europe/romania.html). Codul de generare a hărții este în [pack_sli.py](projects/speed-limit/kit/tools/pack_sli.py).

Harta 1.1.2 folosește datele din 24 noiembrie 2026 și corectează 13 segmente de pe Calea Victoriei la 30 km/h. [Lista segmentelor și sursa oficială](projects/speed-limit/kit/tools/romania-local-limits.json).

Atlasele de fonturi sunt distribuite cu licențele lor în directoarele `kit/runtime/fonts` și `kit/localization/fonts` din fiecare proiect.
