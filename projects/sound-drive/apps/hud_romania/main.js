'use strict';

const mgu = require('./kit/mgu');
const { Canvas } = require('./kit/canvas');
const { conditionOf } = require('./kit/car');
const { ClusterRender } = require('./cluster_render_client');
const { startService } = require('./service');
const { fitText } = require('./hud-view');

mgu.run({
    background(ctx) {
        return startService(ctx, {
            Canvas, conditionOf,
            makeClient: () => {
                const c = new ClusterRender('hud_romania');
                c.on('refused', (op, ref, reason) => ctx.log.warn('Strat HUD refuzat: ' + op + ' ' + reason));
                return c;
            },
        });
    },

    start(ctx) {
        const s = ctx.background;
        ctx.loop('MAIN', 2, () => {
            const cv = ctx.canvas(1600, 520).clear('#080c13');
            const view = s ? s.view() : { eta: '', direction: 'off' };
            const state = s && s.state;
            const status = !state || !state.awake ? 'Așteaptă starea READY' :
                !ctx.settings.get('eta') ? 'ETA dezactivat' : view.eta || s.etaStatus();
            const where = ['Stânga', 'Dreapta', 'Avarii'][['left', 'right', 'both'].indexOf(view.direction)] || 'Inactiv';
            cv.text('HUD România', 90, 114, 52, '#f7f9fc', { font: 'bold' });
            cv.text('CarPlay', 92, 187, 27, '#9ab8de', { font: 'bold' });
            cv.text(status, 92, 234, 36, '#ffffff');
            if (state) cv.text(state.etaDiagnostics(), 92, 288, 23, '#a8b3c4');
            cv.text('Semnalizări: ' + where, 92, 342, 30, '#ffffff');
            const media = view.media ? 'Redare: ' + [view.media.title, view.media.artist].filter(Boolean).join(' · ') :
                ctx.settings.get('media') ? 'Redare: așteaptă o melodie din CarPlay' : 'Redare: afișare dezactivată';
            const textStyle = { literal: true };
            cv.text(fitText(cv, media, 26, 1350, textStyle), 92, 393, 26, '#ffffff', textStyle);
            const output = !s || !s.out.client ? 'HUD în așteptare' :
                s.out.ready ? 'Renderer HUD conectat' : 'Se așteaptă Cluster Renderer';
            cv.text(output, 92, 444, 25, '#a8b3c4');
            return ctx.ui.image('MAIN_GFX', cv);
        });
    },
});
