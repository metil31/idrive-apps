'use strict';

const mgu = require('./kit/mgu');
const { Canvas } = require('./kit/canvas');
const { conditionOf } = require('./kit/car');
const { ClusterRender } = require('./cluster_render_client');
const { startService } = require('./service');
const { fitText } = require('./view');

mgu.run({
    background(ctx) {
        return startService(ctx, {
            Canvas, conditionOf,
            makeClient: () => new ClusterRender('media_hud_ro'),
        });
    },
    start(ctx) {
        ctx.loop('MAIN', 2, () => {
            const cv = ctx.canvas(1600, 520).clear('#080c13');
            const service = ctx.background;
            const track = service && service.track();
            const title = { font: 'bold', literal: true };
            const artist = { literal: true };
            cv.text('Media HUD România', 90, 114, 52, '#f7f9fc', title);
            if (track) {
                cv.text(fitText(cv, track.title, 42, 1350, title), 92, 235, 42, '#ffffff', title);
                if (track.artist) cv.text(fitText(cv, track.artist, 32, 1350, artist), 92, 293, 32, '#dce7f4', artist);
            }
            cv.text(service ? service.status() : 'Se pornește aplicația', 92, 374, 26, '#a8b3c4', artist);
            return ctx.ui.image('MAIN_GFX', cv);
        });
    },
});
