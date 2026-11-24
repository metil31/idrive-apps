#!/usr/bin/env python3
"""
Sound Drive – ALSA-Wiedergabe ohne aplay: Python + ctypes direkt gegen libasound.so.2.

Das Head Unit hat libasound und Python 3.12 (mgu-python), aber kein aplay. Dieses Skript ersetzt aplay:

  alsa_play.py play <gerät> <rate> [puffer_us] [kanäle]
                                     liest S16LE (Stereo oder Mono) von stdin und spielt es auf <gerät> ab
  alsa_play.py list [namen...]       gibt JSON aus: alle ALSA-PCM-Namen (+ zusätzliche) und ob sie sich öffnen lassen
  alsa_play.py tone <gerät> [sek]    spielt einen Testton (440 Hz) – zum Ausprobieren von Hand

Ausgaben auf stderr in Zeilen wie aplay (z. B. "underrun!!!"), damit engine.js sie zählt.
Kanonische Quelle: shared/alsa_play.py – Kopie im Tool erzeugt `npm run sync`.
"""
import array
import ctypes
import ctypes.util
import json
import math
import os
import struct
import sys

SND_PCM_STREAM_PLAYBACK = 0
SND_PCM_NONBLOCK = 1
SND_PCM_FORMAT_S16_LE = 2
SND_PCM_ACCESS_RW_INTERLEAVED = 3
EPIPE = 32
ESTRPIPE = 86
EAGAIN = 11
SND_PCM_STATE_PREPARED = 2


def load_alsa():
    lib, last = None, None
    for n in ['libasound.so.2', 'libasound.so', '/usr/lib/libasound.so.2', '/lib/libasound.so.2']:
        try:
            lib = ctypes.CDLL(n)
            break
        except OSError as e:
            last = e
    if lib is None:
        # find_library ruft ldconfig/gcc auf – auf dem Head Unit (BusyBox) langsam oder nicht vorhanden, daher zuletzt
        try:
            n = ctypes.util.find_library('asound')
            lib = ctypes.CDLL(n) if n else None
        except Exception as e:
            last = e
    if lib is None:
        raise OSError('libasound nicht ladbar: %s' % last)
    lib.snd_strerror.restype = ctypes.c_char_p
    lib.snd_strerror.argtypes = [ctypes.c_int]
    lib.snd_pcm_open.argtypes = [ctypes.POINTER(ctypes.c_void_p), ctypes.c_char_p, ctypes.c_int, ctypes.c_int]
    lib.snd_pcm_set_params.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_uint, ctypes.c_uint,
                                       ctypes.c_int, ctypes.c_uint]
    lib.snd_pcm_writei.restype = ctypes.c_long
    lib.snd_pcm_writei.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_ulong]
    lib.snd_pcm_recover.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int]
    lib.snd_pcm_drain.argtypes = [ctypes.c_void_p]
    lib.snd_pcm_close.argtypes = [ctypes.c_void_p]
    lib.snd_pcm_nonblock.argtypes = [ctypes.c_void_p, ctypes.c_int]
    lib.snd_pcm_delay.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_long)]
    lib.snd_pcm_state.argtypes = [ctypes.c_void_p]
    lib.snd_pcm_start.argtypes = [ctypes.c_void_p]
    lib.snd_pcm_get_params.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_ulong)]
    lib.snd_device_name_hint.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))]
    lib.snd_device_name_get_hint.restype = ctypes.c_void_p
    lib.snd_device_name_get_hint.argtypes = [ctypes.c_void_p, ctypes.c_char_p]
    lib.snd_device_name_free_hint.argtypes = [ctypes.POINTER(ctypes.c_void_p)]
    return lib


def err(lib, code):
    try:
        return '%d %s' % (code, lib.snd_strerror(code).decode('utf-8', 'replace'))
    except Exception:
        return str(code)


def smartx_lock(dev):
    """SmartX legt beim Öffnen /run/smartx/smartx_<Kanal>_p.lock an. Gehört sie root (dieser Dienst), kommen
    BMWs eigene Prozesse (ent_alsa, Gruppe mgu_alsa) nicht mehr an den Kanal und z. B. CarPlay bleibt bis zum
    Neustart stumm. Daher vorher selbst anlegen: Besitzer und Gruppe wie der Ordner /run/smartx selbst (das Konto heißt
    ent_alsaroutingadapters; "ent_alsa" ist nur die von ls gekürzte Anzeige), 0660."""
    i = dev.find('smartx:')
    if i < 0 or not os.path.isdir('/run/smartx'):
        return
    lock = '/run/smartx/smartx_%s_p.lock' % dev[i + 7:]
    try:
        if not os.path.exists(lock):
            os.close(os.open(lock, os.O_CREAT | os.O_WRONLY, 0o660))
        own = os.stat('/run/smartx')
        st = os.stat(lock)
        if st.st_uid != own.st_uid or st.st_gid != own.st_gid:
            os.chown(lock, own.st_uid, own.st_gid)
        os.chmod(lock, 0o660)
    except Exception as e:
        sys.stderr.write('alsa_play: lock %s: %s\n' % (lock, e))
        sys.stderr.flush()


def open_pcm(lib, dev, rate, latency_us, nonblock=False, channels=2):
    h = ctypes.c_void_p()
    r = lib.snd_pcm_open(ctypes.byref(h), dev.encode(), SND_PCM_STREAM_PLAYBACK, SND_PCM_NONBLOCK if nonblock else 0)
    if r < 0:
        return None, 'open: ' + err(lib, r)
    r = lib.snd_pcm_set_params(h, SND_PCM_FORMAT_S16_LE, SND_PCM_ACCESS_RW_INTERLEAVED, int(channels), int(rate), 1, int(latency_us))
    if r < 0:
        lib.snd_pcm_close(h)
        return None, 'set_params: ' + err(lib, r)
    return h, None


def hint_names(lib):
    out = []
    hints = ctypes.POINTER(ctypes.c_void_p)()
    if lib.snd_device_name_hint(-1, b'pcm', ctypes.byref(hints)) < 0:
        return out
    libc = ctypes.CDLL(None)
    libc.free.argtypes = [ctypes.c_void_p]
    i = 0
    while hints[i]:
        def get(key):
            p = lib.snd_device_name_get_hint(hints[i], key)
            if not p:
                return None
            s = ctypes.cast(p, ctypes.c_char_p).value.decode('utf-8', 'replace')
            libc.free(p)
            return s
        name, desc, io = get(b'NAME'), get(b'DESC'), get(b'IOID')
        if name and io != 'Input':
            out.append({'name': name, 'desc': (desc or '').replace('\n', ' ')[:80]})
        i += 1
    lib.snd_device_name_free_hint(hints)
    return out


def cmd_list(extra=None):
    lib = load_alsa()
    names = hint_names(lib)
    seen = set(n['name'] for n in names)
    # Namen aus BMWs ALSA-Konfiguration (vom Dienst gefunden) mit testen
    for extra_name in (extra or []):
        if extra_name not in seen:
            names.append({'name': extra_name, 'desc': 'aus Konfiguration'})
            seen.add(extra_name)
    # die direkten Geräte der Soundkarte und übliche Namen immer mit testen
    for extra in ['default', 'plughw:0,0', 'plughw:0,1', 'hw:0,0', 'hw:0,1', 'sysdefault', 'dmix']:
        if extra not in seen:
            names.append({'name': extra, 'desc': ''})
            seen.add(extra)
    res = []
    for n in names[:80]:
        h, e = open_pcm(lib, n['name'], 44100, 200000, nonblock=True)
        if h:
            lib.snd_pcm_close(h)
        silent = n['name'] == 'null' or n['name'].startswith('null:')
        res.append({'name': n['name'], 'desc': n['desc'], 'ok': h is not None, 'silent': silent, 'error': e})
    print(json.dumps({'devices': res}))


def realtime():
    """Echtzeit-Priorität (SCHED_RR) für den Player: Auf einem ausgelasteten Head Unit (Kamera beim Parken, viele
    Apps) kam er sonst zu spät an die Reihe -> Aussetzer, die als Knistern/Fehlgeräusch zu hören sind. Der Dienst
    läuft als root und darf das. Gibt 'ja' oder den Grund zurück."""
    try:
        os.sched_setscheduler(0, os.SCHED_RR, os.sched_param(5))
        return 'ja'
    except Exception as e:
        return 'nein (%s)' % (getattr(e, 'strerror', None) or e.__class__.__name__)


def realtime_parent():
    """Auch der Dienst (Node, erzeugt den Ton) bekommt Echtzeit-Priorität, unter der des Players: Kommt er auf einem
    ausgelasteten Head Unit zu spät dran, läuft der Puffer leer (Aussetzer). Nur der Hauptthread, und Kindprozesse
    erben sie nicht (RESET_ON_FORK). Nur wenn der Dienst es verlangt (ICONIX_RT_PARENT); scheitert es, bleibt alles
    wie es ist."""
    if os.environ.get('ICONIX_RT_PARENT') != '1':
        return None
    try:
        pid = os.getppid()
        if pid <= 1:
            return None
        os.sched_setscheduler(pid, os.SCHED_RR | os.SCHED_RESET_ON_FORK, os.sched_param(2))
        return 'ja'
    except Exception as e:
        # ohne Echtzeit wenigstens vor den anderen normalen Prozessen (Player und Dienst)
        for p in (0, pid):
            try:
                os.setpriority(os.PRIO_PROCESS, p, -10)
            except Exception:
                pass
        return 'nein (%s)' % (getattr(e, 'strerror', None) or e.__class__.__name__)


class Conceal:
    """Überbrückt ein Stocken des Dienstes ohne Knacken: Harte Stille mitten im Ton hört man als Kratzen. Stattdessen
    wird der zuletzt gespielte Ton rückwärts (nahtlos am letzten Wert) fortgesetzt und über FADE_MS ausgeblendet; geht
    es weiter, blenden die neuen Daten über RESUME_MS ein."""
    FADE_MS, RESUME_MS = 30, 6

    def __init__(self, rate, channels):
        self.ch = channels
        self.keep = max(1, rate * 20 // 1000)
        self.fade = max(1, rate * self.FADE_MS // 1000)
        self.resume = max(1, rate * self.RESUME_MS // 1000)
        self.tail = array.array('h')
        self.pos, self.active = 0, False

    def remember(self, data):
        n = self.keep * self.ch * 2
        if len(data) >= n:
            self.tail = array.array('h', data[-n:])
        elif data:
            self.tail = array.array('h', (self.tail.tobytes() + data)[-n:])

    def audible(self):
        return any(v > 60 or v < -60 for v in self.tail)

    def start(self):
        if not self.active:
            self.active, self.pos = True, 0

    def fill(self, n):
        """n Frames Fortsetzung (Hin- und Herlaufen im letzten Stück Ton, leiser werdend)."""
        ch, t = self.ch, self.tail
        m = len(t) // ch
        out = array.array('h', bytes(2 * n * ch))
        if m < 2:
            self.pos += n
            return out
        span = 2 * (m - 1)
        for i in range(n):
            p = self.pos + i
            g = 1.0 - float(p) / self.fade
            if g <= 0:
                break
            k = (p + 1) % span
            j = (m - 1 - k) if k < m else (k - (m - 1))
            for c in range(ch):
                out[i * ch + c] = int(t[j * ch + c] * g)
        self.pos += n
        return out

    def join(self, data):
        """Erste neue Daten nach dem Stocken einblenden (über die auslaufende Fortsetzung)."""
        if not self.active or not data:
            return data
        ch = self.ch
        a = array.array('h', data)
        n = min(self.resume, len(a) // ch)
        if n:
            f = self.fill(n)
            for i in range(n):
                r = (i + 1.0) / n
                for c in range(ch):
                    k = i * ch + c
                    a[k] = int(a[k] * r + f[k] * (1.0 - r))
        self.active = False
        return a.tobytes()


def cmd_play(dev, rate, latency_us=200000, channels=2):
    lib = load_alsa()
    smartx_lock(dev)
    h, e = open_pcm(lib, dev, rate, latency_us, channels=channels)
    if not h and latency_us > 30000:
        # Kanal nimmt den größeren Puffer nicht: mit dem kleinen
        h, e = open_pcm(lib, dev, rate, 30000, channels=channels)
    if not h:
        sys.stderr.write('alsa_play: %s (%s)\n' % (e, dev))
        sys.stderr.flush()
        return 2
    bsize, psize = ctypes.c_ulong(0), ctypes.c_ulong(0)
    lib.snd_pcm_get_params(h, ctypes.byref(bsize), ctypes.byref(psize))
    rt = realtime()
    rp = realtime_parent()
    if rp is not None:
        rt += ', Dienst ' + rp
    sys.stderr.write('alsa_play: spielt auf %s mit %d Hz, %d Kanal/Kanäle, Puffer %d ms, Periode %d ms, Echtzeit %s\n' % (
        dev, rate, channels, bsize.value * 1000 // max(1, rate), psize.value * 1000 // max(1, rate), rt))
    sys.stderr.flush()
    frame_bytes = 2 * channels
    chunk = 1024 * frame_bytes
    stdin = sys.stdin.buffer
    pending = b''
    # Rückmeldung an engine.js: "P <gespielte Frames>" auf stdout. Damit schreibt der Dienst nur so viel vor,
    # wie wirklich fehlt – ohne sie staute sich Ton in der Pipe (bis ~1 s Verzögerung).
    # Gemeldet werden nur Frames des Dienstes: Die Stille, die dieses Skript selbst nachlegt (Start, Stocken), zählt
    # nicht mit. Sonst hielte der Dienst jede nachgelegte Stille für gespielten eigenen Ton, schriebe entsprechend mehr
    # nach – und die Verzögerung wüchse mit jedem Stocken um mindestens 10 ms, bis der Player neu startet.
    total = 0
    own = 0      # selbst nachgelegte Stille (Frames)
    delay = ctypes.c_long(0)

    def report():
        # ALSA startet sonst erst bei vollem Puffer; ist der größer als der Vorlauf des Dienstes, bliebe es still
        if total > 0 and lib.snd_pcm_state(h) == SND_PCM_STATE_PREPARED:
            lib.snd_pcm_start(h)
        if lib.snd_pcm_delay(h, ctypes.byref(delay)) < 0:
            return
        try:
            os.write(1, ('P %d\n' % max(0, total - own - max(0, delay.value))).encode())
        except OSError:
            pass
    # Schutz gegen Leerlaufen: Stockt der Dienst (Head Unit beim Hochfahren ausgelastet), spielt SmartX sonst den
    # alten Inhalt seines Ringpuffers in Schleife ab - klingt wie ein Quietschen. Darum hier kurz vorher selbst
    # Stille nachlegen. Wird als "underrun" gemeldet, damit der Dienst seinen Vorlauf vergrößert.
    guard = max(1, rate * 12 // 1000)          # weniger als 12 ms im Puffer -> Stille nachlegen
    fill_n = max(1, rate * 10 // 1000)         # je 10 ms
    zeros = bytes(fill_n * frame_bytes)
    conceal = Conceal(rate, channels)
    fd = stdin.fileno()
    fills = 0
    stalled = False
    try:
        import select
    except ImportError:
        select = None
    # mit 20 ms Stille beginnen: SmartX hat dann sofort frische Daten statt alter Reste im Ringpuffer
    for _ in range(2):
        w = lib.snd_pcm_writei(h, zeros, fill_n)
        if w > 0:
            total += w
            own += w
    try:
        while True:
            if select is not None and total > 0:
                d = delay.value if lib.snd_pcm_delay(h, ctypes.byref(delay)) >= 0 else 0
                wait = max(0.002, (d - guard) / float(rate))
                ready = select.select([fd], [], [], wait)[0]
                if not ready:
                    r = lib.snd_pcm_delay(h, ctypes.byref(delay))
                    if r < 0:
                        lib.snd_pcm_recover(h, int(r), 1)
                        delay.value = 0
                    if delay.value < guard:
                        conceal.start()
                        w = lib.snd_pcm_writei(h, conceal.fill(fill_n).tobytes(), fill_n)
                        if w > 0:
                            total += w
                            own += w
                            # je Stocken EINE Meldung (beim ersten Nachlegen), damit der Dienst jedes Mal
                            # mitzählt und seinen Vorlauf vergrößert – auch nach vielen Aussetzern. War ohnehin
                            # Stille (Motor aus, stummgeschaltet), hört man nichts: keine Meldung.
                            if not stalled and conceal.audible():
                                fills += 1
                                sys.stderr.write('underrun!!! (Stille nachgelegt, #%d)\n' % fills)
                                sys.stderr.flush()
                            stalled = True
                            report()
                        elif w < 0:
                            lib.snd_pcm_recover(h, int(w), 1)
                    continue
                data = os.read(fd, chunk)
            elif select is not None:
                data = os.read(fd, chunk)      # nicht mit stdin.read1 mischen (dessen Puffer würde Bytes behalten)
            else:
                data = stdin.read1(chunk) if hasattr(stdin, 'read1') else stdin.read(chunk)
            if not data:
                break
            stalled = False
            data = pending + data
            n = len(data) // frame_bytes
            pending = data[n * frame_bytes:]
            buf = conceal.join(data[:n * frame_bytes])
            off = 0
            while off < n:
                w = lib.snd_pcm_writei(h, buf[off * frame_bytes:], n - off)
                if w < 0:
                    if w in (-EPIPE, -ESTRPIPE) and conceal.audible():
                        sys.stderr.write('underrun!!!\n')
                        sys.stderr.flush()
                    r = lib.snd_pcm_recover(h, int(w), 1)
                    if r < 0:
                        sys.stderr.write('alsa_play: write: %s\n' % err(lib, r))
                        sys.stderr.flush()
                        return 3
                    # der Ton war weg: den Rest weich einblenden statt mit einem Sprung
                    conceal.start()
                    conceal.pos = conceal.fade
                    buf = buf[:off * frame_bytes] + conceal.join(buf[off * frame_bytes:])
                    continue
                off += w
                total += w
            conceal.remember(buf)
            report()
    except (BrokenPipeError, KeyboardInterrupt):
        pass
    finally:
        if rp == 'ja':
            # kein Ton mehr: der Dienst läuft wieder wie jeder andere
            try:
                os.sched_setscheduler(os.getppid(), os.SCHED_OTHER, os.sched_param(0))
            except Exception:
                pass
        lib.snd_pcm_close(h)
    return 0


def cmd_tone(dev, seconds=2.0):
    lib = load_alsa()
    rate = 44100
    h, e = open_pcm(lib, dev, rate, 200000)
    if not h:
        print('Fehler: %s' % e)
        return 2
    frames = int(rate * seconds)
    data = b''.join(struct.pack('<hh', int(8000 * math.sin(2 * math.pi * 440 * i / rate)),
                                int(8000 * math.sin(2 * math.pi * 440 * i / rate))) for i in range(frames))
    off = 0
    while off < frames:
        w = lib.snd_pcm_writei(h, data[off * 4:], frames - off)
        if w < 0:
            if lib.snd_pcm_recover(h, int(w), 1) < 0:
                break
            continue
        off += w
    lib.snd_pcm_drain(h)
    lib.snd_pcm_close(h)
    print('ok')
    return 0


if __name__ == '__main__':
    a = sys.argv[1:]
    try:
        if a and a[0] == 'list':
            cmd_list(a[1:])
        elif len(a) >= 3 and a[0] == 'play':
            sys.exit(cmd_play(a[1], int(a[2]), int(a[3]) if len(a) > 3 else 200000, int(a[4]) if len(a) > 4 else 2))
        elif len(a) >= 2 and a[0] == 'tone':
            sys.exit(cmd_tone(a[1], float(a[2]) if len(a) > 2 else 2.0))
        else:
            sys.stderr.write(__doc__)
            sys.exit(1)
    except OSError as e:
        if a and a[0] == 'list':
            print(json.dumps({'devices': [], 'error': str(e)}))
        else:
            sys.stderr.write('alsa_play: %s\n' % e)
        sys.exit(4)
