'use strict';

const { decodeTrack, field, isPlaying } = require('./media');
const { MediaOutput } = require('./media-view');

const CONDITION = 'de.bmw.infrastructure.VehicleCondition';
const MEDIA = 'de.bmw.infotainment.entertainment.mediaplayer.MediaPlayer';

function startService(ctx, deps) {
    const { signals, settings, log, app } = ctx;
    const out = new MediaOutput(deps.makeClient, deps.Canvas, deps.ScaledCanvas);
    let awake = false, track = null, playing = false, stopped = false, player = null, wasAvailable = false;
    const subs = [];
    const outputTrack = () => settings.get('enabled') && awake && player && player.available && playing ? track : null;
    const sampleTrack = { title: 'Demo · Midnight Drive', artist: 'Metil' };
    const tick = () => {
        if (stopped) return;
        const available = !!(player && player.available);
        if (wasAvailable && !available) { track = null; playing = false; }
        wasAvailable = available;
        const sample = deps.preview && deps.preview();
        const target = sample === 'mediaHud' ? 'hud' : sample === 'mediaCluster' ? 'cluster' : null;
        const display = target ? { get: key => key === 'show' ? target : settings.get(key) } : settings;
        out.update(target ? sampleTrack : outputTrack(), display);
    };
    function watch(iface, instance, handlers) {
        const wrapped = {};
        Object.keys(handlers).forEach((key) => {
            wrapped[key] = (value) => {
                if (stopped) return;
                handlers[key](value);
                tick();
            };
        });
        return signals.watch(iface, instance, wrapped, log).then((sub) => {
            if (stopped) return sub.shutdown();
            subs.push(sub);
            return sub;
        }).catch((error) => log.warn('Source unavailable: ' + iface + ': ' + error.message));
    }
    watch(CONDITION, '1', {
        VehicleCondition: (value) => { awake = deps.conditionOf(field(value, 'statusConditionVehicle')) === 10; },
    });
    watch(MEDIA, 'CarPlayMedia', {
        currentItemMetadata: (value) => { track = decodeTrack(value); },
        playerState: (value) => { playing = isPlaying(value); },
    }).then((sub) => { if (!stopped && sub) { player = sub; tick(); } });
    settings.onChange(tick);
    const timer = setInterval(tick, 250);
    if (timer.unref) timer.unref();
    const stop = () => {
        if (stopped) return;
        stopped = true;
        clearInterval(timer);
        out.stop();
        subs.forEach((sub) => Promise.resolve(sub.shutdown()).catch(() => {}));
    };
    if (app && typeof app.on === 'function') app.on('shutdown', stop);
    function status(t = en => en) {
        if (!settings.get('enabled')) return t('Display disabled', 'Afisare dezactivata');
        if (!awake) return t('Waiting for READY', 'Asteapta starea READY');
        if (!player || !player.available) return t('Waiting for CarPlay audio', 'Asteapta sursa audio CarPlay');
        if (!playing || !track) return t('Waiting for playback', 'Asteapta redarea');
        if (!out.ready) return t('Waiting for renderer', 'Asteapta rendererul');
        if (out.layers.cluster) return out.layers.hud ? t('Media on HUD and cluster', 'Media pe HUD si pe bord') : t('Media on cluster', 'Media pe bord');
        if (settings.get('show') === 'cluster') return t('Waiting for cluster map', 'Asteapta harta din bord');
        return settings.get('show') === 'both' ? t('Media on HUD · waiting for cluster map', 'Media pe HUD · asteapta harta din bord') : t('Media on HUD', 'Media pe HUD');
    }
    return { status, track: outputTrack, tick, stop };
}

module.exports = { startService };
