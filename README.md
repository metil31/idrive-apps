# Metil's iDrive 7 Apps

One MGU Store source for BMW head units running iDrive 7 (MGU/ID7).

> **Live Waze features require Waze open and visible on the main iDrive screen in Apple CarPlay.** This applies to Waze ETA, maneuvers, lane and fork guidance, and the optional Waze source in Speed Limit Romania, including when the outputs are on the HUD or instrument cluster. The cluster map alone cannot supply these readings. Built-in demos can be used without Waze.

## Install and update

1. Open **Sources** in MGU Store and add `metil31/idrive-apps`.
2. Select the **mgu-romania** branch and refresh the source.
3. Install or update only the apps you want. MGU Store resolves their declared tool dependencies. For HUD and cluster overlays, make [cluster-render](https://github.com/robertnisipeanu/idrive-apps) available in your sources. To show overlays on the cluster map, keep a compatible **Maps on cluster** map active in the instrument cluster.

The menus default to English. Select **Language → Romana** for Romanian without diacritics. Position controls move overlays in 10-pixel steps where provided. Move and resize each screen independently. Demos are for a stationary vehicle and stop when you leave their settings page, start moving, or reach the 90-second limit. A cluster-map demo needs an active map.

| App | Current version | Function |
| --- | --- | --- |
| **Metil's HUD Apps** | 0.2.3 | Turn signals, native CarPlay ETA, and now-playing information |
| **Waze ETA iOS** | 0.3.5 | Waze ETA, turns, roundabout exit number, lane guidance and forks |
| **Speed Limit Romania** | 1.3.2 | Offline speed limits, cameras and priority signs, with an optional Waze limit |
| **Seat Comfort** | 0.1.2 | Automatic front-seat heating at a cold start |
| **Waze CarPlay Reader** | 0.3.1 | Shared capture tool for Waze ETA iOS and the optional Speed Limit Romania source |

## Waze ETA iOS

Enable arrival and maneuvers independently for the windshield HUD and the cluster map. Keep an active Waze route visible on the centre CarPlay screen. The reader samples approximately every four seconds and supports the tested 8:3 CarPlay layout. Use the built-in demos to position ETA, left and right turns, roundabouts, lanes and forks independently of Waze.

Cluster-map ETA has a translucent background with soft rounded edges. It fits the text and dims the map beneath it. It renders to a 1080 × 192 texture at 4× scale and sends only the changed region when the label updates. The HUD and maneuver overlays use 3× textures. The reader schedules captures only while an app requests data and the CarPlay capture gate permits it.

- For a fork, the recommended branch is white and the other branch is muted. A roundabout shows the exit number inside a small circle next to the distance.
- Experimental lane recognition looks for the lane row inside the full-screen Waze maneuver card. It can distinguish a recommended turn within a lane that also allows going straight. Unrecognized rows and rows without a distinguishable recommendation are omitted.
- New maneuvers and lane rows require two matching readings. An isolated missed frame can briefly retain a confirmed turn, without retaining the missing lane row. Changing away from the centre CarPlay screen stops live readings. The last verified ETA can remain visible for up to two minutes from its last valid capture.

The capture reads the **centre display**. The separate cluster video can remain visible while iDrive shows an unrelated app, but on the tested configuration it contains the map and route only. Continuous off-screen access to the centre CarPlay guidance is still unverified on the vehicle. [Apple's instrument-cluster scene documentation](https://developer.apple.com/documentation/carplay/cptemplateapplicationinstrumentclusterscene) · [Maps on cluster's separate video pipeline](https://github.com/robertnisipeanu/idrive-apps/blob/main/native/waze-on-cluster/README.md)

## Speed Limit Romania

The offline map provides speed limits and advance alerts for cameras, STOP and Give way. You can correct a particular road manually from the menu. The HUD speed sign can be as small as 40 px. The cluster overlay uses the iDrive 7 full panel (1920 × 720) with or without a map in the cluster. Use the movement controls to adjust the position in 10 px steps. While the panel is visible, iDrive can hide its stock cluster media widget. BMW display arbitration may temporarily hide the overlay during a vehicle warning. Priority signs briefly replace the speed sign in the same position. Their HUD and cluster switches are independent. Demos cover the speed sign, camera, STOP and Give way.

To try the experimental supplement, set Waze on the iPhone to always show the speed limit next to its speedometer. Start a route, then select one of the following options in **Speed Limit Romania → Waze speed limit**. [Waze speedometer settings](https://support.google.com/waze/answer/6386895/get-speed-limit-alerts?hl=en-GB)

- **Off** is the default. Use the offline map and local corrections.
- **When the offline limit is uncertain** accepts a confirmed Waze reading when the offline value is missing, inferred, conditional, variable or directionally uncertain.
- **Prefer Waze** can temporarily show a different confirmed Waze limit, even when the offline map has an explicit value.

Both options require Waze visible on the main iDrive screen in Apple CarPlay, with a readable active metric route and a clearly recognized speed-limit sign. The figure in Waze's adjacent speedometer is excluded. Two consecutive readings must agree and fall within the same locally matched road and direction. Manual corrections take precedence, and the app falls back to the offline result when the reading expires, disagrees, or the road or direction changes. The comparison is local and temporary. It updates the display only and does not edit the offline map, cruise control or the vehicle's speed-limit assistance. The menu shows the available Waze reading and the offline value when a Waze reading takes over.

See [data provenance and verification](projects/speed-limit/VERIFICARE.md) for the offline pack and the difference between source disagreement and a verified permanent correction. Follow the actual road signs.

## Metil's HUD Apps

The native iDrive menu has separate pages for **Media**, **Turn signals**, and **Native CarPlay ETA**. The native ETA uses route estimates sent directly to iDrive by compatible navigation apps. Waze ETA iOS reads the visible Waze interface separately.

Media shows the current song and artist on the HUD, the active cluster map, or both, with independent position and size. Album art is optional and depends on the source. On the cluster map, the rounded background fits the title, artist and cover. On the HUD, Media remains transparent behind its text. Enable **Show song and artist** in the Media page. If the old standalone Media HUD app is still installed, turn off its display before enabling the merged one. [Credits and licenses](projects/sound-drive/apps/hud_romania/NOTICE)

Turn signals and native ETA schedule updates for the next visible change. Media checks artwork and playback availability while a track or demo is displayed.

## Seat Comfort

Select the front seats, heat level and outside-temperature threshold. The defaults are both front seats, level 2 and 8 °C. Enable automatic startup in the menu. The app tries once per selected seat, after the vehicle goes from off to READY while stationary and strictly below the threshold. The command has a three-minute duration. Turning the heating off manually will not trigger another start in the same cycle.

Experimental and specific to compatible BDC_G05 front heating. Seat-module checks are repeated at least 20 seconds apart before activation. The app reports the result in its menu. Rear heating and ventilation are unavailable in this version. [Heating Comfort reference](https://github.com/NamelsMissing/mgu-apps/tree/main/apps/g21_wheelheat)

## Build and verify

Use the corresponding iDrive app kit in `projects/sound-drive` or `projects/speed-limit` and the OAP SDK expected by that kit. From the project directory, build with `python kit/tools/build.py <app-id>`. The app IDs are `hud_romania`, `waze_eta_ro`, `speed_limit` and `scaune_calde_ro`. MGU Store uses [mgu-repo.json](mgu-repo.json) to locate the build and its dependencies.

Run `node projects/sound-drive/kit/tools/test_waze_eta_ro.js`, `node projects/speed-limit/kit/tools/test_speed_limit_ro.js` and `node projects/speed-limit/kit/tools/test_speed_limit_outputs.js` from the repository root for the primary regressions. The 0.3.0 reader was also replayed locally with 30, 80 and 130 km/h references, both fork directions (one mirrored), a full lane row and a partial lane row. Some public references use different screen dimensions. Their relevant crops were replayed within the known test layout, so this validates the glyphs rather than full-layout compatibility on the vehicle. [80 km/h](https://s1.cdn.autoevolution.com/images/news-gallery-860x/my-5-waze-settings-for-perfect-navigation-on-the-daily-commute-thumbnail_3.jpg) · [130 km/h and a fork, figure 6](https://rosap.ntl.bts.gov/view/dot/94253/dot_94253_DS1.pdf) · [Complete lane row](https://s1.cdn.autoevolution.com/images/news/google-brings-key-google-maps-feature-to-waze-on-android-auto-and-carplay-143166_1.jpg) · [Partial lane row](https://www.waze.com/discuss/t/lane-guidance-partially-displayed/281868)

New capture features have been tested locally and still need confirmation on the vehicle.

## Sources and licenses

- **Speed Limit Romania** is GPL-3.0-or-later, with preserved MIT notices. [Upstream](https://github.com/hexlay/idrive7-custom-apps) · [Romanian base](https://github.com/metil31/idrive7-speed-limit-romania/tree/77b05b0d6bf6aebda431770fd37e3dd2b7ecca1d) · [GPL](projects/speed-limit/LICENSE) · [MIT](projects/speed-limit/LICENSE.MIT) · [Sign artwork notice](projects/speed-limit/apps/speed_limit/NOTICE)
- The offline pack uses [OpenStreetMap data](https://www.openstreetmap.org/copyright), licensed under the [ODbL](https://opendatacommons.org/licenses/odbl/1-0/), from [Geofabrik's Romania extract](https://download.geofabrik.de/europe/romania.html). See [the compiled pack](projects/speed-limit/apps/speed_limit/romania.pack), [generator](projects/speed-limit/kit/tools/pack_sli.py), and [documented local limits](projects/speed-limit/kit/tools/romania-local-limits.json).
- **Sound Drive** and **Sound Drive Audio** remain archived in source. [Upstream](https://github.com/Nico1003/sound-drive/tree/b7901d9abc2f69464def12278c81bb8023379224) · [Romanian version](https://github.com/metil31/sound-drive-ro/tree/b42cd42e7407222bb2c723b74c0e4df31a24f87f) · [MIT license](projects/sound-drive/LICENSE)
- Font licenses ship with their atlases under each project's `kit/runtime/fonts` and `kit/localization/fonts`. Individual app notices are included in the corresponding app directories.

Independent community project for compatible BMW vehicles.
