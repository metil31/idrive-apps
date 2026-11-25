'use strict';

const { HudState, field } = require('./hud-state');
const { HudOutput } = require('./hud-view');
const { decodeTrack, isPlaying } = require('./media');

const CONDITION = 'de.bmw.infrastructure.VehicleCondition';
const LIGHT = 'de.bmw.body.Light';
const GUIDANCE = 'de.bmw.infotainment.navigation.projectedmodeguiding.ProjectedModeGuiding';
const PROVIDER = 'de.bmw.infotainment.navigation.guiding.Guidance';
const CARPLAY = 'de.bmw.infotainment.a4a.carplay.CarPlayManager';
const MEDIA = 'de.bmw.infotainment.entertainment.mediaplayer.MediaPlayer';

function startService(ctx, deps) {
    const { signals, settings, log, app } = ctx;
    const now = deps.now || Date.now;
    const state = new HudState();
    const out = new HudOutput(deps.makeClient, deps.Canvas);
    let stopped = false;
    const subscriptions = [];
    const retryTimers = new Set();
    let media = null, track = null, playing = false, mediaWasAvailable = false;
    const view = () => {
        const current = state.view(now(), settings);
        const available = !!(media && media.available);
        if (mediaWasAvailable && !available) {
            track = null;
            playing = false;
        }
        mediaWasAvailable = available;
        current.media = state.awake && settings.get('media') && available && playing ? track : null;
        return current;
    };
    const tick = () => { if (!stopped) out.update(view(), settings); };
    const watch = (iface, instance, handlers, onSubscribed, attempt = 0) => {
        const retry = (error) => {
            if (stopped || attempt >= 3 || /no SOME\/IP config|native module not available/i.test(String(error))) return;
            const timeout = setTimeout(() => {
                retryTimers.delete(timeout);
                if (!stopped) watch(iface, instance, handlers, onSubscribed, attempt + 1);
            }, 5000 * (attempt + 1));
            retryTimers.add(timeout);
            if (timeout.unref) timeout.unref();
        };
        const bound = {};
        Object.keys(handlers).forEach((key) => {
            bound[key] = (v) => { if (!stopped) { handlers[key](v); tick(); } };
        });
        return signals.watch(iface, instance, bound, log).then((sub) => {
            if (stopped) return sub.shutdown();
            if (sub.error && !sub.proxy) { retry(sub.error); return; }
            subscriptions.push(sub);
            if (onSubscribed) onSubscribed(sub);
        }).catch((e) => {
            log.warn('Sursă indisponibilă: ' + iface + ': ' + e.message);
            retry(e);
        });
    };
    watch(CONDITION, '1', {
        VehicleCondition: (v) => state.setReady(deps.conditionOf(field(v, 'statusConditionVehicle')) === 10),
    });
    watch(LIGHT, '1', {
        StatusFunctionsIndicators: (v) => state.setIndicator(v, now()),
        StatusFunctionsIndicators2: (v) => state.setIndicator(v, now()),
    });
    const flag = (key) => (v) => state.setFlag(key, v);
    watch(CARPLAY, 'CarPlayManagerInst1', {
        projectedGuidanceActive: flag('projectedGuidanceActive'),
        projectedGuidanceMetadataAvailable: flag('projectedGuidanceMetadataAvailable'),
    });
    watch(GUIDANCE, 'Main_Instance', { waypoints: (v) => state.setWaypoints(v, now()) });
    watch(PROVIDER, 'Main_Instance', { guidingProvider: (v) => state.setProvider(v) });
    watch(MEDIA, 'CarPlayMedia', {
        currentItemMetadata: (v) => { track = decodeTrack(v); },
        playerState: (v) => { playing = isPlaying(v); },
    }, (sub) => { media = sub; tick(); });
    settings.onChange(tick);
    const timer = setInterval(tick, 100);
    if (timer.unref) timer.unref();
    const stop = () => {
        if (stopped) return;
        stopped = true;
        clearInterval(timer);
        retryTimers.forEach(clearTimeout);
        retryTimers.clear();
        out.stop();
        subscriptions.forEach((sub) => sub.shutdown().catch(() => {}));
    };
    if (app && typeof app.on === 'function') app.on('shutdown', stop);
    return { state, out, view, etaStatus: () => state.etaStatus(now()), stop };
}

module.exports = { startService };
