'use strict';

const { decodeTrack, field, isPlaying } = require('./media');
const { MediaOutput } = require('./view');

const CONDITION = 'de.bmw.infrastructure.VehicleCondition';
const MEDIA = 'de.bmw.infotainment.entertainment.mediaplayer.MediaPlayer';

function startService(ctx, deps) {
    const { signals, settings, log, app } = ctx;
    const out = new MediaOutput(deps.makeClient, deps.Canvas);
    let awake = false, track = null, playing = false, stopped = false, player = null, wasAvailable = false;
    const subs = [];
    const outputTrack = () => settings.get('enabled') && awake && player && player.available && playing ? track : null;
    const tick = () => {
        if (stopped) return;
        const available = !!(player && player.available);
        if (wasAvailable && !available) { track = null; playing = false; }
        wasAvailable = available;
        out.update(outputTrack(), settings);
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
        }).catch((error) => log.warn('Sursă indisponibilă: ' + iface + ': ' + error.message));
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
    function status() {
        if (!settings.get('enabled')) return 'Afișare dezactivată';
        if (!awake) return 'Așteaptă starea READY';
        if (!player || !player.available) return 'Așteaptă conectarea sursei audio CarPlay';
        if (!playing || !track) return 'Așteaptă o melodie în redare';
        if (!out.ready) return 'Așteaptă rendererul';
        if (out.layers.cluster) return out.layers.hud ? 'Media pe HUD și pe bord' : 'Media pe bord';
        if (settings.get('show') === 'cluster') return 'Așteaptă harta activă pe bord';
        return settings.get('show') === 'both' ? 'Media pe HUD · așteaptă harta pe bord' : 'Media pe HUD';
    }
    return { status, track: outputTrack, stop };
}

module.exports = { startService };
