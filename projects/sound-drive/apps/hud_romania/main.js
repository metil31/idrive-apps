'use strict';

const mgu = require('./kit/mgu');
const { Canvas } = require('./kit/canvas');
const { conditionOf } = require('./kit/car');
const { ClusterRender } = require('./cluster_render_client');
const { startService } = require('./service');
const { wireMenu } = require('./menu');

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

    start: wireMenu,
});
