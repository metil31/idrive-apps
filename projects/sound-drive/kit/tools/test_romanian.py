"""Romanian package checks: catalog, technical identity, diacritics and MGU staging."""
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "kit" / "tools"))
from localize import localize_spec  # noqa: E402


def load(path):
    return json.loads(path.read_text(encoding="utf-8"))


source = load(ROOT / "apps" / "iconix_sounds" / "app.json")
ro = localize_spec(source, "ro-RO")
assert ro["id"] == source["id"] == "iconix_sounds"
assert ro["loggingId"] == source["loggingId"] == "ICXS"
assert ro["requires"] == source["requires"]
assert ro["signals"] == source["signals"]
assert [s["key"] for s in ro["settings"]] == [s["key"] for s in source["settings"]]
assert ro["version"] == source["version"] == "1.0.9"
assert ro["screens"][0]["buttons"][0][1] == "Schimbă sunetul"
assert next(s for s in ro["settings"] if s["key"] == "volume")["label"] == "Volum"
assert next(s for s in ro["settings"] if s["key"] == "loadSource")["label"] == "Sursă de sarcină"
assert next(s for s in ro["settings"] if s["key"] == "bassDb")["group"] == "Reglare sunet"

catalog = load(ROOT / "kit" / "runtime" / "locales" / "ro.json")
joined = "\n".join(catalog.values())
for char in "ăâîșț":
    assert char in joined, f"catalogul nu verifică diacritica {char}"
for wrong in "şţŞŢ":
    assert wrong not in joined, f"diacritică veche cu sedilă: {wrong}"

for family in ("label", "bold", "light"):
    font = load(ROOT / "kit" / "localization" / "fonts" / "ro" / f"{family}.json")
    for face in font["sizes"]:
        # Specialized very-large faces may omit letters entirely; every normal text face must carry Romanian.
        if all(str(ord(c)) in face["glyphs"] for c in "aAisStT"):
            for char in "ăâîșțĂÂÎȘȚ":
                assert str(ord(char)) in face["glyphs"], f"{family}/{face['size']} nu conține {char}"

store = load(ROOT / "mgu-repo.json")["apps"]["build"]
app_id = source["id"]
version = source["version"]
assert store["output"].format(id=app_id, version=version) == f"dist/{app_id}@{version}.tgz"
args = [arg.format(id=app_id, version=version) for arg in store["args"]]
subprocess.run([sys.executable, str(ROOT / store["python"]), "--preview-only", *args], cwd=ROOT, check=True)
package = ROOT / "dist" / app_id / "source"
runtime = package / "javascript" / "kit"
staged = load(runtime / "app-spec.json")
assert staged["version"] == version == load(package / "package.json")["version"]
assert load(runtime / "locale.json")["language"] == "ro"
assert load(package / "package.json")["license"] == "MIT"
assert (package / "LICENSE").read_bytes() == (ROOT / "LICENSE").read_bytes()
assert staged["screens"][0]["buttons"][3][1] == "Diagnostic audio"
subprocess.run(["node", "-e", """
const { t } = require('./i18n');
const assert = require('assert');
assert.strictEqual(t('Settings'), 'Setări');
assert.strictEqual(t('Off'), 'Dezactivat');
assert.strictEqual(t('Overlay-Mix: verbunden · SmartX'), 'Mix suprapus: conectat · SmartX');
"""], cwd=runtime, check=True)
print("Romanian localization: OK")
