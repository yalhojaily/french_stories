#!/usr/bin/env python3
"""
Petit Carnet: بناء بيانات الموقع وتوليد الصوت

  python tools/build.py            يفحص القصص ويبني data/bundle.js (بدون اتصال بالإنترنت)
  python tools/build.py --voices   يعرض الأصوات المتاحة في حسابك على ElevenLabs
  python tools/build.py --audio    يولّد الصوت الناقص فقط ثم يبني الموقع
  python tools/build.py --audio --force   يعيد توليد كل الأصوات

الإعدادات تُقرأ من ملف .env في جذر المشروع (انظر .env.example).
المفتاح يبقى على جهازك فقط: الموقع نفسه يقرأ ملفات mp3 الجاهزة ولا يتصل بـ ElevenLabs.
"""
import argparse
import base64
import hashlib
import json
import os
import re
import sys
import time
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STORIES = ROOT / "stories"
AUDIO = ROOT / "audio"
WORDS = AUDIO / "words"
MANIFEST = AUDIO / "manifest.json"
VOICES = ROOT / "voices.json"
BUNDLE = ROOT / "data" / "bundle.js"
API = "https://api.elevenlabs.io/v1"


# ─────────────────────────────── الإعدادات ───────────────────────────────

def load_env():
    env = {}
    f = ROOT / ".env"
    if f.exists():
        for line in f.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
    for k in ("ELEVENLABS_API_KEY", "ELEVENLABS_VOICE_ID", "ELEVENLABS_MODEL", "ELEVENLABS_SPEED"):
        if os.environ.get(k):
            env[k] = os.environ[k]
    return env


# ─────────────────────────────── قراءة القصص ───────────────────────────────

class StoryError(Exception):
    pass


def parse_file(path):
    stories, cur, sent = [], None, None
    for n, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = raw.strip()
        where = f"{path.name}:{n}"
        if not line or line.startswith("#"):
            continue
        if line.startswith("@"):
            key, _, val = line[1:].partition(" ")
            val = val.strip()
            if key == "id":
                cur = {"id": val, "grammar": {"title": "", "paras": [], "table": []}, "sentences": [], "speaker": None}
                stories.append(cur)
                sent = None
                continue
            if cur is None:
                raise StoryError(f"{where}: يجب أن يبدأ كل قصة بـ @id")
            if key == "week":
                cur["week"] = int(val)
            elif key in ("title", "title_ar", "summary"):
                cur[key] = val
            elif key == "speaker":
                cur["speaker"] = val or None
            elif key == "grammar_title":
                cur["grammar"]["title"] = val
            elif key == "grammar":
                cur["grammar"]["paras"].append(val)
            elif key == "table":
                fr, _, ar = val.partition("|")
                cur["grammar"]["table"].append([fr.strip(), ar.strip()])
            else:
                raise StoryError(f"{where}: وسم غير معروف @{key}")
        elif line.startswith(">"):
            if cur is None:
                raise StoryError(f"{where}: جملة قبل @id")
            fields = [x.strip() for x in line[1:].split("|")]
            if len(fields) not in (2, 3):
                raise StoryError(f"{where}: الصيغة: > الجملة | الترجمة | المتحدث (المتحدث اختياري)")
            who = fields[2] if len(fields) == 3 and fields[2] else cur["speaker"]
            sent = {"fr": fields[0], "ar": fields[1], "words": [], "line": where, "who": who}
            cur["sentences"].append(sent)
        else:
            if sent is None:
                raise StoryError(f"{where}: كلمة قبل أي جملة")
            head, _, rest = line.partition("|")
            word, eq, meaning = head.partition("=")
            if not eq:
                raise StoryError(f"{where}: الصيغة: الكلمة = المعنى")
            w = {"t": word.strip(), "ar": meaning.strip()}
            for attr in rest.split("|") if rest else []:
                k, _, v = attr.strip().partition("=")
                if k not in ("l", "g", "n", "s"):
                    raise StoryError(f"{where}: خاصية غير معروفة «{k}» (المتاح: l g n s)")
                w[k] = v.strip()
            sent["words"].append(w)
    return stories


def segment(sent):
    """يقسّم الجملة إلى كلمات قابلة للضغط وفواصل، ويتأكد أن كل كلمة مذكورة."""
    fr, parts, cursor = sent["fr"], [], 0
    for w in sent["words"]:
        idx = fr.find(w["t"], cursor)
        if idx == -1:
            raise StoryError(f"{sent['line']}: الكلمة «{w['t']}» غير موجودة (بالترتيب) في: {fr}")
        gap = fr[cursor:idx]
        if any(c.isalpha() for c in gap):
            raise StoryError(f"{sent['line']}: «{gap.strip()}» بلا ترجمة في: {fr}")
        if gap:
            parts.append(gap)
        parts.append(dict(w, _a=idx, _b=idx + len(w["t"])))
        cursor = idx + len(w["t"])
    tail = fr[cursor:]
    if any(c.isalpha() for c in tail):
        raise StoryError(f"{sent['line']}: «{tail.strip()}» بلا ترجمة في: {fr}")
    if tail:
        parts.append(tail)
    return parts


def load_stories():
    stories = []
    for f in sorted(STORIES.glob("*.txt")):
        stories.extend(parse_file(f))
    ids = [s["id"] for s in stories]
    dup = {i for i in ids if ids.count(i) > 1}
    if dup:
        raise StoryError(f"معرّف مكرر: {', '.join(sorted(dup))}")
    for s in stories:
        for k in ("week", "title", "title_ar"):
            if k not in s:
                raise StoryError(f"القصة {s['id']} ينقصها @{k}")
        for sent in s["sentences"]:
            sent["parts"] = segment(sent)
        # القصة متعددة الأصوات إذا حُدّد متحدث لأي جملة فيها؛ الجمل بلا متحدث يقرؤها الراوي
        s["multi"] = any(x["who"] for x in s["sentences"])
    stories.sort(key=lambda s: (s["week"], s["id"]))
    return stories


def story_text(story):
    offsets, pos = [], 0
    for i, s in enumerate(story["sentences"]):
        if i:
            pos += 1
        offsets.append(pos)
        pos += len(s["fr"])
    return " ".join(s["fr"] for s in story["sentences"]), offsets


# ─────────────────────────────── ElevenLabs ───────────────────────────────

def sha(s):
    return hashlib.sha1(s.encode("utf-8")).hexdigest()[:10]


def slug(text):
    t = unicodedata.normalize("NFKD", text.lower())
    t = "".join(c for c in t if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9]+", "-", t).strip("-")[:24] or "w"


def word_file(text):
    return f"words/{slug(text)}-{sha(text.lower())}.mp3"


def request(method, url, key, body=None):
    import requests
    headers = {"xi-api-key": key}
    for attempt in range(5):
        r = requests.request(method, url, headers=headers, json=body, timeout=180)
        if r.status_code == 200:
            return r
        if r.status_code in (429, 500, 502, 503, 504):
            wait = 2 ** attempt * 2
            print(f"   ⏳ {r.status_code}، إعادة المحاولة بعد {wait} ثانية")
            time.sleep(wait)
            continue
        if r.status_code == 402 and "paid_plan_required" in r.text:
            sys.exit("✗ هذا الصوت من مكتبة الأصوات (Voice Library)، والخطة المجانية لا تسمح باستخدامه عبر API.\n"
                     "  الحل: شغّل  python tools/build.py --voices  واختر صوتاً من القائمة الأولى (premade أو generated)،\n"
                     "  ثم ضع معرّفه في ELEVENLABS_VOICE_ID داخل ملف .env")
        if "quota_exceeded" in r.text:
            sys.exit("✗ نفد رصيدك في ElevenLabs لهذا الشهر. ما وُلّد محفوظ؛ أعد التشغيل بعد تجدد الرصيد وسيكمل الناقص فقط.")
        if r.status_code == 404 and "voice" in r.text.lower():
            sys.exit(f"✗ معرّف صوت غير موجود في حسابك. راجع voices.json أو .env\n  {r.text[:300]}")
        if r.status_code == 401:
            sys.exit("✗ المفتاح غير صحيح (401). تأكد من ELEVENLABS_API_KEY في ملف .env")
        sys.exit(f"✗ خطأ من ElevenLabs ({r.status_code}): {r.text[:400]}")
    sys.exit("✗ فشلت المحاولات المتكررة")


def tts_body(text, cfg):
    body = {"text": text, "model_id": cfg["model"]}
    if cfg["speed"]:
        body["voice_settings"] = {"speed": cfg["speed"]}
    return body


FREE_OK = {"premade", "generated", "cloned"}  # Library (professional/shared) غير متاح مجاناً عبر API


def list_voices(key):
    data = request("GET", f"{API}/voices", key).json()
    voices = data.get("voices", [])
    ok = [v for v in voices if v.get("category") in FREE_OK]
    lib = [v for v in voices if v.get("category") not in FREE_OK]

    def show(v):
        labels = v.get("labels") or {}
        desc = ", ".join(str(x) for x in labels.values() if x)
        print(f"  {v['name'][:26]:<27} {v['voice_id']:<24} {v.get('category','')}  {desc}")

    print("\n✓ أصوات تعمل مع الخطة المجانية (اختر منها):")
    print("  " + "─" * 76)
    for v in ok:
        show(v)
    if lib:
        print("\n✗ أصوات من مكتبة الأصوات (Voice Library) تحتاج خطة مدفوعة عبر API:")
        print("  " + "─" * 76)
        for v in lib:
            show(v)
    print("\nضع المعرّف الذي تختاره في ملف .env بجانب ELEVENLABS_VOICE_ID")
    print("الأصوات الافتراضية (premade) متعددة اللغات وتنطق الفرنسية جيداً مع eleven_multilingual_v2.")
    print("لصوت فرنسي أصلي مجاناً: أنشئ صوتاً من Voice Design في موقع ElevenLabs (يظهر هنا بفئة generated).")


def load_voices():
    if not VOICES.exists():
        return None
    v = json.loads(VOICES.read_text(encoding="utf-8"))
    for k in ("narrator", "female", "male"):
        if not v.get(k):
            sys.exit(f"✗ voices.json ينقصه «{k}»")
    v["cast"] = {n.lower(): g for n, g in (v.get("cast") or {}).items()}
    return v


def voice_for(who, voices):
    """يحدد معرّف الصوت للمتحدث: الراوي، أو أنثى، أو ذكر."""
    if not who or who.lower() in ("narrator", "راوي", "الراوي"):
        return voices["narrator"], "narrator"
    role = voices["cast"].get(who.lower())
    if role not in ("female", "male", "narrator"):
        sys.exit(f"✗ المتحدث «{who}» غير معرّف في cast داخل voices.json (اكتب female أو male)")
    return voices[role], role


def generate_multi(story, cfg, voices, manifest, force):
    """يولّد كل جملة بصوت متحدثها في ملف مستقل، مع توقيت كل حرف."""
    sid, sents, chars = story["id"], story["sentences"], 0
    folder = AUDIO / sid
    folder.mkdir(parents=True, exist_ok=True)
    segs = manifest.setdefault("segments", {}).setdefault(sid, {})
    announced = False
    for i, s in enumerate(sents):
        voice, role = voice_for(s["who"], voices)
        prev_t = sents[i - 1]["fr"] if i else None
        next_t = sents[i + 1]["fr"] if i + 1 < len(sents) else None
        h = sha(f"{s['fr']}|{voice}|{cfg['model']}|{cfg['speed']}|{prev_t}|{next_t}")
        mp3 = folder / f"{i}.mp3"
        if not force and segs.get(str(i), {}).get("hash") == h and mp3.exists():
            continue
        if not announced:
            print(f"▶ القصة {sid}: {story['title']} (أصوات متعددة)")
            announced = True
        print(f"   {i + 1:>2}. [{role:<8}] {s['who'] or 'الراوي'}: {s['fr']}")
        body = tts_body(s["fr"], cfg)
        # السياق المجاور يحسّن نغمة الجملة لتبدو جزءاً من قصة لا جملة معزولة
        if prev_t:
            body["previous_text"] = prev_t
        if next_t:
            body["next_text"] = next_t
        res = request("POST", f"{API}/text-to-speech/{voice}/with-timestamps", cfg["key"], body).json()
        mp3.write_bytes(base64.b64decode(res["audio_base64"]))
        al = res.get("alignment") or {}
        if len(al.get("characters", [])) != len(s["fr"]):
            print(f"      ⚠ التوقيت لا يطابق النص تماماً، قد يكون التظليل غير دقيق")
        segs[str(i)] = {"hash": h, "role": role,
                        "starts": al.get("character_start_times_seconds", []),
                        "ends": al.get("character_end_times_seconds", [])}
        chars += len(s["fr"])
        MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
    for k in [k for k in segs if int(k) >= len(sents)]:
        del segs[k]
    return chars


def generate_audio(stories, cfg, force, only=None):
    key, voice = cfg["key"], cfg["voice"]
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8")) if MANIFEST.exists() else {"stories": {}, "words": {}}
    manifest.setdefault("stories", {}); manifest.setdefault("words", {})
    sig = f"{voice}|{cfg['model']}|{cfg['speed']}"
    WORDS.mkdir(parents=True, exist_ok=True)
    chars = 0

    voices = load_voices()
    targets = [s for s in stories if not only or s["id"] in only]
    for story in targets:
        if story["multi"]:
            if not voices:
                sys.exit(f"✗ القصة {story['id']} فيها متحدثون لكن ملف voices.json غير موجود")
            chars += generate_multi(story, cfg, voices, manifest, force)
            MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
            continue
        text, _ = story_text(story)
        h = sha(text + sig)
        mp3 = AUDIO / f"{story['id']}.mp3"
        old = manifest["stories"].get(story["id"], {})
        if not force and old.get("hash") == h and mp3.exists():
            continue
        print(f"▶ القصة {story['id']}: {story['title']} ({len(text)} حرفاً)")
        res = request("POST", f"{API}/text-to-speech/{voice}/with-timestamps", key, tts_body(text, cfg)).json()
        mp3.write_bytes(base64.b64decode(res["audio_base64"]))
        al = res.get("alignment") or {}
        if len(al.get("characters", [])) != len(text):
            print(f"   ⚠ عدد أحرف التوقيت ({len(al.get('characters', []))}) لا يطابق النص ({len(text)})، قد يكون التظليل غير دقيق")
        manifest["stories"][story["id"]] = {
            "hash": h,
            "starts": al.get("character_start_times_seconds", []),
            "ends": al.get("character_end_times_seconds", []),
        }
        chars += len(text)
        MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")

    words = {}
    for story in targets:
        for s in story["sentences"]:
            for p in s["parts"]:
                if isinstance(p, dict):
                    say = p.get("s", p["t"])
                    words[say.lower()] = say
    for low, say in sorted(words.items()):
        rel = word_file(say)
        if not force and manifest["words"].get(low) == sig and (AUDIO / rel).exists():
            continue
        print(f"   🔊 {say}")
        audio = request("POST", f"{API}/text-to-speech/{voice}", key, tts_body(say, cfg)).content
        (AUDIO / rel).write_bytes(audio)
        manifest["words"][low] = sig
        chars += len(say)
        MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")

    print(f"✓ الصوت جاهز. أحرف مستهلكة في هذا التشغيل: {chars}")


# ─────────────────────────────── بناء الموقع ───────────────────────────────

def word_entry(p):
    w = {k: v for k, v in p.items() if not k.startswith("_") and k != "s"}
    rel = word_file(p.get("s", p["t"]))
    if (AUDIO / rel).exists():
        w["a"] = "audio/" + rel
    return w


def bundle_multi(story, manifest):
    segs = manifest.get("segments", {}).get(story["id"], {})
    sentences, n_words, all_ok = [], 0, True
    for i, s in enumerate(story["sentences"]):
        seg = segs.get(str(i))
        mp3 = AUDIO / story["id"] / f"{i}.mp3"
        ok = bool(seg and seg.get("starts") and mp3.exists())
        all_ok = all_ok and ok
        starts, ends = (seg["starts"], seg["ends"]) if ok else ([], [])

        def span(a, b):
            return [round(starts[min(a, len(starts) - 1)], 3), round(ends[min(b, len(ends) - 1)], 3)]

        parts = []
        for p in s["parts"]:
            if isinstance(p, str):
                parts.append(p)
                continue
            w = word_entry(p)
            n_words += "a" in w
            if ok:
                w["ts"] = span(p["_a"], p["_b"] - 1)
            parts.append(w)
        sent = {"fr": s["fr"], "ar": s["ar"], "parts": parts, "who": s["who"] or ""}
        if ok:
            sent["a"] = f"audio/{story['id']}/{i}.mp3"
            sent["ts"] = span(0, len(s["fr"]) - 1)
            sent["role"] = seg.get("role", "")
        sentences.append(sent)
    entry = {k: story[k] for k in ("id", "week", "title", "title_ar")}
    entry.update(summary=story.get("summary", ""), grammar=story["grammar"], sentences=sentences)
    if all_ok:
        entry["segs"] = True
    return entry, n_words, int(all_ok)


def build_bundle(stories):
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8")) if MANIFEST.exists() else {"stories": {}, "words": {}}
    out, n_audio, n_words = [], 0, 0
    for story in stories:
        if story["multi"]:
            entry, nw, ok = bundle_multi(story, manifest)
            out.append(entry); n_words += nw; n_audio += ok
            continue
        text, offsets = story_text(story)
        timing = manifest.get("stories", {}).get(story["id"])
        mp3 = AUDIO / f"{story['id']}.mp3"
        has_audio = bool(timing and mp3.exists() and timing.get("starts"))
        starts = timing["starts"] if has_audio else []
        ends = timing["ends"] if has_audio else []

        def span(a, b):
            a = min(a, len(starts) - 1)
            b = min(b, len(ends) - 1)
            return [round(starts[a], 3), round(ends[b], 3)]

        sentences = []
        for s, off in zip(story["sentences"], offsets):
            parts = []
            for p in s["parts"]:
                if isinstance(p, str):
                    parts.append(p)
                    continue
                w = {k: v for k, v in p.items() if not k.startswith("_") and k != "s"}
                say = p.get("s", p["t"])
                rel = word_file(say)
                if (AUDIO / rel).exists():
                    w["a"] = "audio/" + rel
                    n_words += 1
                if has_audio:
                    w["ts"] = span(off + p["_a"], off + p["_b"] - 1)
                parts.append(w)
            sent = {"fr": s["fr"], "ar": s["ar"], "parts": parts}
            if has_audio:
                sent["ts"] = span(off, off + len(s["fr"]) - 1)
            sentences.append(sent)
        entry = {k: story[k] for k in ("id", "week", "title", "title_ar") if k in story}
        entry["summary"] = story.get("summary", "")
        entry["grammar"] = story["grammar"]
        entry["sentences"] = sentences
        if has_audio:
            entry["audio"] = f"audio/{story['id']}.mp3"
            n_audio += 1
        out.append(entry)

    BUNDLE.parent.mkdir(parents=True, exist_ok=True)
    js = "/* ملف مولَّد تلقائياً بواسطة tools/build.py — لا تعدّله يدوياً */\nwindow.CARNET = "
    js += json.dumps({"stories": out}, ensure_ascii=False, separators=(",", ":")) + ";\n"
    BUNDLE.write_text(js, encoding="utf-8")
    n_sent = sum(len(s["sentences"]) for s in out)
    print(f"✓ data/bundle.js: {len(out)} قصة، {n_sent} جملة، {n_audio} قصة بصوت، {n_words} كلمة بصوت")


def main():
    ap = argparse.ArgumentParser(description="بناء بيانات موقع Petit Carnet")
    ap.add_argument("--audio", action="store_true", help="توليد الصوت الناقص عبر ElevenLabs")
    ap.add_argument("--force", action="store_true", help="إعادة توليد كل الأصوات")
    ap.add_argument("--voices", action="store_true", help="عرض الأصوات المتاحة في حسابك")
    ap.add_argument("--only", help="قصص محددة فقط، مثل: --only 01 أو --only 01,02")
    args = ap.parse_args()

    env = load_env()
    cfg = {
        "key": env.get("ELEVENLABS_API_KEY", ""),
        "voice": env.get("ELEVENLABS_VOICE_ID", ""),
        "model": env.get("ELEVENLABS_MODEL") or "eleven_multilingual_v2",
        "speed": float(env["ELEVENLABS_SPEED"]) if env.get("ELEVENLABS_SPEED") else None,
    }

    if args.voices or args.audio:
        if not cfg["key"] or cfg["key"].startswith("ضع"):
            sys.exit("✗ لم أجد المفتاح. انسخ .env.example إلى .env وضع مفتاحك بجانب ELEVENLABS_API_KEY")
        try:
            import requests  # noqa: F401
        except ImportError:
            sys.exit("✗ ثبّت المكتبة أولاً: pip install requests")
    if args.voices:
        list_voices(cfg["key"])
        return

    try:
        stories = load_stories()
    except StoryError as e:
        sys.exit(f"✗ خطأ في القصص: {e}")
    print(f"✓ {len(stories)} قصة سليمة")

    if args.audio:
        if not cfg["voice"]:
            sys.exit("✗ اختر صوتاً أولاً: python tools/build.py --voices ثم ضع المعرّف في ELEVENLABS_VOICE_ID")
        only = {x.strip().zfill(2) for x in args.only.split(",")} if args.only else None
        if only and not only & {s["id"] for s in stories}:
            sys.exit(f"✗ لا توجد قصة بالمعرّف {args.only}")
        generate_audio(stories, cfg, args.force, only)

    build_bundle(stories)


if __name__ == "__main__":
    main()
