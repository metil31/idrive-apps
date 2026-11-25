'use strict';

const mgu = require('./kit/mgu');
const { Canvas } = require('./kit/canvas');
const { conditionOf } = require('./kit/car');
const { ClusterRender } = require('./cluster_render_client');
const { startService } = require('./service');
const { captureTest } = require('./waze-capture');

mgu.run({
    background(ctx) {
        const service = startService(ctx, {
            Canvas, conditionOf,
            makeClient: () => {
                const c = new ClusterRender('hud_romania');
                c.on('refused', (op, ref, reason) => ctx.log.warn('Strat HUD refuzat: ' + op + ' ' + reason));
                return c;
            },
        });
        service.wazeTest = captureTest(ctx.dataDir);
        ctx.app.on('shutdown', service.wazeTest.stop);
        return service;
    },

    start(ctx) {
        const s = ctx.background;
        if (s) ctx.ui.onClick('BTN_WAZE_TEST', s.wazeTest.start);
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
            cv.text('Semnalizări: ' + where, 92, 344, 30, '#ffffff');
            const output = !s || !s.out.client ? 'HUD în așteptare' :
                s.out.ready ? 'Renderer HUD conectat' : 'Se așteaptă Cluster Renderer';
            cv.text(output, 92, 394, 24, '#a8b3c4');
            if (s) cv.text(s.wazeTest.status(), 92, 454, 24, '#f7f9fc', { literal: true });
            return ctx.ui.image('MAIN_GFX', cv);
        });
    },
});
