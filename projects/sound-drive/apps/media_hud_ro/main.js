'use strict';

const mgu = require('./kit/mgu');
const { Canvas, ScaledCanvas } = require('./kit/canvas');
const { conditionOf } = require('./kit/car');
const { ClusterRender } = require('./cluster_render_client');
const { startService } = require('./service');
const { wireMenu } = require('./menu');

mgu.run({
    background(ctx) {
        return startService(ctx, {
            Canvas, ScaledCanvas, conditionOf,
            makeClient: () => new ClusterRender('media_hud_ro'),
        });
    },
    start: wireMenu,
});
