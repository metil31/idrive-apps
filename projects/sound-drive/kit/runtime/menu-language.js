'use strict';

function menuLanguage({ ui, settings, spec }) {
    const romanian = () => settings.get('menuLanguage') === 'ro';
    const t = (en, ro) => romanian() ? ro : en;
    const applied = {};
    ui.onClick('APP_LANGUAGE', ({ row }) => {
        if (row === 0 || row === 1) settings.set('menuLanguage', row === 1 ? 'ro' : 'en');
    });
    function render(screen = 'MAIN') {
        const ro = romanian();
        if (applied[screen] === ro) return false;
        applied[screen] = ro;
        const page = spec.screens.find(item => item.name === screen);
        const labels = spec.config && spec.config.menuRomanian || {};
        if (!page) return false;
        if (labels[screen + '_TITLE']) ui.text(screen + '_TITLE', ro ? labels[screen + '_TITLE'][0] : page.title);
        for (const [id, label] of page.buttons || []) {
            if (labels[id]) ui.text(id, ro ? labels[id][0] : label);
        }
        for (const [kind, id, label, options] of page.items || []) {
            const entry = labels[id];
            if (!entry) continue;
            const text = ro ? entry[0] : label;
            if (kind === 'dropdown') {
                const component = ui.comp(id);
                if (component) Promise.resolve().then(() => component.setValue('HeaderText', text, 'Text')).catch(() => {});
                (ro && entry[1] || options).forEach((name, row) => ui.text(id, name, row, 'ItemText'));
            } else if (kind === 'slider') ui.cells(id, 0, { TextDescription: text });
            else ui.text(id, text);
        }
        if (screen === 'MAIN') ui.selected('APP_LANGUAGE', ro ? 1 : 0);
        return true;
    }
    return { t, render };
}

module.exports = { menuLanguage };
