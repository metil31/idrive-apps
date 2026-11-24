# Sound Drive în limba română pentru BMW iDrive 7

Versiune românească a aplicației **Sound Drive**, un sunet virtual de motor pentru BMW cu iDrive 7 (MGU), controlat de turația și sarcina reale ale motorului și redat prin difuzoarele mașinii.

> Proiect neoficial, fără afiliere cu BMW AG. Modificările unității MGU se fac pe propria răspundere. Păstrează volumul suficient de redus pentru a auzi avertizările și sunetele din jur.

## Ce conține această versiune

- interfața Sound Drive, setările și mesajele de stare/diagnostic traduse în română;
- diacritice românești corecte (`ă â î ș ț`) incluse în fonturile aplicației;
- aceiași algoritmi audio, aceleași profiluri, identificatoare, semnale BMW, rute SmartX/ALSA și valori stocate ca în sursa originală;
- pachet cu limbă implicită `ro`, versiune `1.0.9`;
- compatibilitate declarată cu MGU Store și `mguHmi: ["ID7", "ID8"]`, moștenită din proiectul verificat.

Nu a fost efectuată nicio instalare pe mașină.

## Instalare prin MGU Store

Este necesar un BMW iDrive 7 (MGU) cu acces root și [MGU Store](https://github.com/robertnisipeanu/mgu-store). După publicarea repository-ului, acesta poate fi adăugat ca sursă în MGU Store. Aplicația **Sound Drive** instalează automat dependența opțională **Sound Drive Audio**.

Acest repository nu include și nu automatizează instalarea pe vehicul.

## Construire și verificare

Previzualizarea românească, fără SDK BMW și fără pachet instalabil:

```powershell
python kit/tools/build.py --preview-only iconix_sounds
```

MGU Store construiește pachetul cu SDK-ul OAP disponibil pe unitate. Testele locale sunt în `kit/tools/` și rulează pe calculator. Comenzile folosite în GitHub Actions sunt păstrate în [șablonul de teste](docs/ci/app-tests.yml).

## Sursă și licență

Derivat verificat din:

- repository: <https://github.com/Nico1003/sound-drive>
- commit de bază: `b7901d9abc2f69464def12278c81bb8023379224`
- licență: MIT, păstrată integral în [LICENSE](LICENSE)

Fișierul original README în limba germană este păstrat în [docs/README_UPSTREAM_DE.md](docs/README_UPSTREAM_DE.md). Drepturile de autor și condițiile licenței MIT rămân neschimbate.
