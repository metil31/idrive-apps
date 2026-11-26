'use strict';

const mgu = require('./kit/mgu');
const { Canvas, ScaledCanvas } = require('./kit/canvas');
const { conditionOf } = require('./kit/car');
const { displayPreview } = require('./kit/display-preview');
const { menuLanguage } = require('./kit/menu-language');
const { ClusterRender } = require('./cluster_render_client');
const { startService } = require('./service');
const { startService: startMedia } = require('./media-service');
const { wireMenu } = require('./menu');
const { wireMenu: wireMedia } = require('./media-menu');

function mediaSettings(settings) {
    const keyOf = key => 'media' + key[0].toUpperCase() + key.slice(1);
    return {
        get: key => settings.get(keyOf(key)),
        set: (key, value) => settings.set(keyOf(key), value),
        item: key => settings.item(keyOf(key)),
        onChange: callback => settings.onChange(callback),
    };
}

mgu.run({
    background(ctx) {
        let hud, media;
        const preview = displayPreview(ctx.signals, ctx.log, () => hud && hud.state.awake, () => {
            hud.tick();
            media.tick();
        });
        const deps = { Canvas, ScaledCanvas, conditionOf, preview: preview.current,
            makeClient: () => new ClusterRender('hud_romania') };
        hud = startService(ctx, deps);
        media = startMedia(Object.assign({}, ctx, { settings: mediaSettings(ctx.settings) }), deps);
        ctx.app.on('shutdown', preview.stop);
        return { hud, media, preview };
    },

    start(ctx) {
        const { background, ui } = ctx;
        const language = menuLanguage(ctx);
        const preview = background && background.preview;
        const pages = { HUD_MEDIA: ['HR_OPEN_MEDIA', 'MR'], HUD_IND: ['HR_OPEN_IND', 'HR_IND'],
            HUD_ETA: ['HR_OPEN_ETA', 'HR_ETA'] };
        for (const [page, [button, prefix]] of Object.entries(pages)) {
            ui.onClick(button, () => ui.open(page));
            if (preview) ui.onClick(prefix + '_DEMO_STOP', preview.stop);
        }
        ui.onVisible((name, open) => { if (!open && pages[name] && preview) preview.stop(); });
        const renderDemo = (page, write) => {
            const prefix = pages[page][1], { t } = language;
            write('enabled', prefix + '_DEMO_STOP', !!(preview && preview.selected()));
            write('text', prefix + '_DEMO_STATUS', preview && preview.current() ? t('Demo active', 'Demo activ') :
                t('Demo requires READY and standstill', 'Demo disponibil in READY cu masina oprita'));
        };
        wireMenu(Object.assign({}, ctx, { background: background && background.hud, language, preview, renderDemo }));
        wireMedia(Object.assign({}, ctx, {
            background: background && background.media, settings: mediaSettings(ctx.settings), language, preview, renderDemo,
        }));
    },
});
