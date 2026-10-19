/* Petit Carnet: منطق الموقع */
(function () {
  "use strict";

  const DATA = (window.CARNET && window.CARNET.stories) || [];
  const view = document.getElementById("view");
  const $ = (sel, el = document) => el.querySelector(sel);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const AR_DIGITS = "٠١٢٣٤٥٦٧٨٩";
  const ar = (n) => String(n).replace(/\d/g, (d) => AR_DIGITS[d]);

  const WEEKS = {
    1: { title: "التعارف والأساسيات", sub: "être وavoir، أدوات التعريف والنكرة، الأرقام" },
    2: { title: "الحياة اليومية", sub: "أفعال ‎-er، النفي، السؤال، الوقت والأيام" },
    3: { title: "الحركة والرغبات", sub: "aller وfaire وvouloir وpouvoir، المستقبل القريب، الصفات" },
    4: { title: "الماضي والمراجعة", sub: "الماضي المركّب مع avoir وêtre، ومراجعة ختامية" },
  };

  /* ───────── التخزين (قد لا يكون متاحاً، فكل شيء داخل try) ───────── */
  const store = {
    get(k, d) { try { const v = localStorage.getItem("carnet." + k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem("carnet." + k, JSON.stringify(v)); } catch (e) { /* تجاهل */ } },
  };
  const state = {
    done: new Set(store.get("done", [])),
    saved: store.get("saved", {}),
    speed: store.get("speed", 1),
    showTr: store.get("showTr", false),
    genders: store.get("genders", true),
  };
  const saveDone = () => store.set("done", [...state.done]);
  const saveWords = () => { store.set("saved", state.saved); updateBadge(); };

  /* ───────── تحليل البيانات: الكلمات الجديدة في كل قصة ───────── */
  const keyOf = (w) => (w.l || w.t).toLowerCase();
  (function analyse() {
    const seen = new Set();
    DATA.forEach((st) => {
      const fresh = new Set();
      st.sentences.forEach((s) => {
        let pos = 0;
        s.parts.forEach((p) => {
          if (typeof p === "string") { pos += p.length; return; }
          p._a = pos; p._b = pos + p.t.length; pos = p._b;
          const k = keyOf(p);
          if (!seen.has(k)) { fresh.add(k); }
        });
      });
      fresh.forEach((k) => seen.add(k));
      st._new = fresh.size;
    });
  })();
  const byId = (id) => DATA.find((s) => s.id === id);
  const nextStory = () => DATA.find((s) => !state.done.has(s.id)) || DATA[0];

  /* ───────── الصوت ───────── */
  const synth = window.speechSynthesis;
  let frVoice = null;
  function pickVoice() {
    if (!synth) return;
    const vs = synth.getVoices().filter((v) => /^fr/i.test(v.lang));
    const score = (v) => (/fr[-_]FR/i.test(v.lang) ? 4 : 0) + (/natural|premium|enhanced|neural/i.test(v.name) ? 3 : 0) + (/google|amélie|audrey|thomas|marie|denise|henri/i.test(v.name) ? 2 : 0) + (v.localService ? 0 : 1);
    vs.sort((a, b) => score(b) - score(a));
    frVoice = vs[0] || null;
  }
  if (synth) { pickVoice(); synth.onvoiceschanged = pickVoice; }

  const wordAudio = new Audio();
  function speak(text, rate, hooks = {}) {
    if (!synth) { toast("متصفحك لا يدعم القراءة الصوتية"); hooks.onend && hooks.onend(); return; }
    synth.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "fr-FR";
    if (frVoice) u.voice = frVoice;
    u.rate = (rate || 1) * 0.92;
    if (hooks.onboundary) u.onboundary = hooks.onboundary;
    u.onend = () => hooks.onend && hooks.onend();
    u.onerror = () => hooks.onend && hooks.onend();
    synth.speak(u);
  }
  function playWord(w) {
    stopWord();
    if (w.a) {
      wordAudio.src = w.a;
      wordAudio.playbackRate = 1;
      wordAudio.play().catch(() => speak(w.t, 0.85));
    } else {
      speak(w.t, 0.85);
    }
  }
  function stopWord() { try { wordAudio.pause(); } catch (e) {} }

  /* ───────── الرسائل القصيرة ───────── */
  let toastT;
  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), 2600);
  }

  /* ───────── المراجعة (صناديق لايتنر) ───────── */
  const INTERVALS = [0, 1, 2, 4, 8, 16]; // بالأيام
  const today = () => Math.floor(Date.now() / 86400000);
  const wordId = (w) => (w.t + "|" + w.ar).toLowerCase();
  const isSaved = (w) => !!state.saved[wordId(w)];
  const dueWords = () => Object.values(state.saved).filter((w) => w.due <= today());
  function toggleSave(w, story, sentence) {
    const id = wordId(w);
    if (state.saved[id]) { delete state.saved[id]; saveWords(); return false; }
    state.saved[id] = { t: w.t, ar: w.ar, l: w.l || "", g: w.g || "", n: w.n || "", a: w.a || "", ctx: sentence ? sentence.fr : "", story: story ? story.id : "", box: 0, due: today() };
    saveWords();
    return true;
  }
  function updateBadge() {
    const b = $("#due-badge"), n = dueWords().length;
    b.hidden = n === 0; b.textContent = ar(n);
  }

  /* ───────── بطاقة الكلمة ───────── */
  const pop = $("#pop");
  let popCtx = null;
  function noteHtml(n) {
    // الكلمات اللاتينية داخل الملاحظة تُعزل لتظهر بالاتجاه الصحيح وسط النص العربي
    const re = /[A-Za-zÀ-ÿœŒ][A-Za-zÀ-ÿœŒ'’ .…+\-]*[A-Za-zÀ-ÿœŒ.…]|[A-Za-zÀ-ÿœŒ]/g;
    let out = "", last = 0, m;
    while ((m = re.exec(n))) { out += esc(n.slice(last, m.index)) + "<bdi>" + esc(m[0]) + "</bdi>"; last = m.index + m[0].length; }
    return out + esc(n.slice(last));
  }
  function openPop(btn, w, story, si) {
    closePop();
    popCtx = { btn, w, story, si };
    btn.classList.add("sel");
    $("#pop-word").textContent = w.t;
    const g = $("#pop-g");
    g.hidden = !w.g; g.className = "chip " + (w.g || ""); g.textContent = w.g === "f" ? "مؤنث" : "مذكر";
    const lem = $("#pop-lemma");
    lem.hidden = !w.l || w.l === w.t;
    if (w.l) lem.innerHTML = "الأصل: <span>" + esc(w.l) + "</span>";
    $("#pop-ar").textContent = w.ar;
    const note = $("#pop-note");
    note.hidden = !w.n; if (w.n) note.innerHTML = noteHtml(w.n);
    $("#pop-ctx").hidden = si == null;
    renderSaveBtn();
    pop.hidden = false;
    placePop(btn);
    playWord(w);
  }
  function renderSaveBtn() {
    const b = $("#pop-save"), on = popCtx && isSaved(popCtx.w);
    b.textContent = on ? "✓ محفوظة" : "احفظ للمراجعة";
    b.classList.toggle("btn-ink", false);
    b.setAttribute("aria-pressed", on ? "true" : "false");
  }
  function placePop(btn) {
    if (window.innerWidth < 640) { pop.classList.add("sheet-mode"); pop.style.left = pop.style.top = ""; return; }
    pop.classList.remove("sheet-mode");
    const r = btn.getBoundingClientRect(), pw = pop.offsetWidth, ph = pop.offsetHeight;
    let left = r.left + r.width / 2 - pw / 2 + window.scrollX;
    left = Math.max(16 + window.scrollX, Math.min(left, window.scrollX + document.documentElement.clientWidth - pw - 16));
    let top = r.bottom + 10 + window.scrollY;
    if (r.bottom + ph + 110 > window.innerHeight && r.top - ph - 10 > 70) top = r.top - ph - 10 + window.scrollY;
    pop.style.left = left + "px"; pop.style.top = top + "px";
  }
  function closePop() {
    if (popCtx && popCtx.btn) popCtx.btn.classList.remove("sel");
    popCtx = null; pop.hidden = true;
  }
  $("#pop-close").addEventListener("click", closePop);
  $("#pop-say").addEventListener("click", () => popCtx && playWord(popCtx.w));
  $("#pop-ctx").addEventListener("click", () => { if (popCtx && player) player.playSentence(popCtx.si, true); });
  $("#pop-save").addEventListener("click", () => {
    if (!popCtx) return;
    const s = popCtx.story && popCtx.si != null ? popCtx.story.sentences[popCtx.si] : null;
    const on = toggleSave(popCtx.w, popCtx.story, s);
    renderSaveBtn();
    if (popCtx.btn) popCtx.btn.classList.toggle("saved", on);
    toast(on ? "حُفظت الكلمة في المراجعة" : "أُزيلت من المراجعة");
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closePop(); });
  document.addEventListener("click", (e) => {
    if (!pop.hidden && !pop.contains(e.target) && !e.target.closest(".w, .demo-w")) closePop();
  });
  window.addEventListener("resize", () => { if (popCtx && popCtx.btn) placePop(popCtx.btn); });

  /* ───────── المشغّل ───────── */
  let player = null;
  function makePlayer(story, root) {
    // ثلاثة أوضاع: seg = ملف لكل جملة بصوت متحدثها، file = ملف واحد للقصة، tts = صوت المتصفح
    const audio = story.segs ? new Audio() : story.audio ? new Audio(story.audio) : null;
    let mode = story.segs ? "seg" : audio ? "file" : "tts";
    let segTimer = 0, finished = false;
    let playing = false, cur = -1, stopAt = null, raf = 0, ttsIdx = 0, ttsOnce = false;
    const bar = $(".player", root), fill = $(".prog-bar i", root), txt = $(".prog-l", root), src = $(".prog-r", root);
    const sentEls = [...root.querySelectorAll(".s")];
    const total = story.sentences.length;
    if (audio) {
      audio.preload = "auto";
      audio.addEventListener("error", () => { if (mode === "file" || mode === "seg") { mode = "tts"; label(); toast("تعذّر تحميل ملف الصوت، سأستعمل صوت المتصفح"); } });
      audio.addEventListener("ended", () => {
        if (mode !== "seg") { finish(); return; }
        segEnd();
      });
    }
    function segEnd() {
        cancelAnimationFrame(raf);
        markWord(null);
        if (stopAt === "once") { stopAt = null; setPlaying(false); return; }
        if (cur >= total - 1) { finish(); return; }
        const next = cur + 1;
        segTimer = setTimeout(() => { if (playing) segFrom(next, false); }, 280);
    }
    function label() {
      if (mode === "seg") { const s = story.sentences[cur < 0 ? 0 : cur]; src.textContent = "صوت ElevenLabs · " + (s && s.who && !/^(narrator|راوي|الراوي)$/i.test(s.who) ? s.who : "الراوي"); return; }
      src.textContent = mode === "file" ? "صوت ElevenLabs" : (frVoice ? "صوت المتصفح" : "صوت المتصفح (لا يوجد صوت فرنسي)");
    }
    label();
    if (synth && mode === "tts") setTimeout(label, 600);

    function setPlaying(p) {
      playing = p; bar.classList.toggle("playing", p);
      if (p) { finished = false; bar.classList.remove("finished"); }
      else cancelAnimationFrame(raf);
    }
    // نهاية القصة: زر التشغيل يتحول إلى «من البداية»
    function finish() {
      setPlaying(false); clearHl(); fill.style.width = "100%";
      finished = true; cur = -1; stopAt = null;
      bar.classList.add("finished");
      txt.textContent = "انتهت القصة · اضغط للإعادة من البداية";
    }
    function clearHl() { root.querySelectorAll(".w.hl").forEach((e) => e.classList.remove("hl")); sentEls.forEach((e) => e.classList.remove("on")); }
    function markSentence(i) {
      if (i === cur) return;
      cur = i;
      sentEls.forEach((e, k) => e.classList.toggle("on", k === i));
      txt.textContent = "الجملة " + ar(i + 1) + " من " + ar(total);
      if (mode === "seg") label();
      const el = sentEls[i];
      if (el) {
        const r = el.getBoundingClientRect();
        if (r.top < 80 || r.bottom > window.innerHeight - 110) el.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }
    function markWord(si, pi) {
      root.querySelectorAll(".w.hl").forEach((e) => e.classList.remove("hl"));
      if (pi == null) return;
      const el = root.querySelector('.w[data-s="' + si + '"][data-p="' + pi + '"]');
      if (el) el.classList.add("hl");
    }

    /* ملف صوتي + توقيتات */
    function tick() {
      const t = audio.currentTime;
      if (stopAt != null && t >= stopAt) { audio.pause(); setPlaying(false); stopAt = null; markWord(null); return; }
      fill.style.width = (audio.duration ? (t / audio.duration) * 100 : 0) + "%";
      let si = story.sentences.findIndex((s) => s.ts && t >= s.ts[0] - 0.05 && t <= s.ts[1] + 0.25);
      if (si === -1) { for (let k = story.sentences.length - 1; k >= 0; k--) if (story.sentences[k].ts && t >= story.sentences[k].ts[0]) { si = k; break; } }
      if (si > -1) {
        markSentence(si);
        const parts = story.sentences[si].parts;
        let pi = null;
        parts.forEach((p, k) => { if (typeof p !== "string" && p.ts && t >= p.ts[0] - 0.03 && t <= p.ts[1] + 0.06) pi = k; });
        markWord(si, pi);
      }
      raf = requestAnimationFrame(tick);
    }
    function fileFrom(i, once) {
      const s = story.sentences[i];
      audio.currentTime = s && s.ts ? s.ts[0] : 0;
      stopAt = once && s && s.ts ? s.ts[1] + 0.15 : null;
      audio.playbackRate = state.speed;
      audio.play().then(() => { setPlaying(true); cancelAnimationFrame(raf); raf = requestAnimationFrame(tick); })
        .catch(() => { mode = "tts"; label(); ttsFrom(i, once); });
    }

    /* ملف لكل جملة: التوقيتات نسبية لبداية الجملة */
    function segTick() {
      const s = story.sentences[cur];
      if (!s) return;
      // المقطع المقتطع من ملف القصة القديم: الوقت نسبي لبداية المقطع، وينتهي عند نهايته
      const base = s.clip ? s.clip[0] : 0, len = s.clip ? s.clip[1] - s.clip[0] : audio.duration;
      const t = audio.currentTime - base;
      if (s.clip && t >= len) { audio.pause(); segEnd(); return; }
      fill.style.width = ((cur + (len ? Math.min(1, t / len) : 0)) / total) * 100 + "%";
      let pi = null;
      s.parts.forEach((p, k) => { if (typeof p !== "string" && p.ts && t >= p.ts[0] - 0.03 && t <= p.ts[1] + 0.06) pi = k; });
      markWord(cur, pi);
      raf = requestAnimationFrame(segTick);
    }
    function segFrom(i, once) {
      clearTimeout(segTimer);
      const s = story.sentences[i];
      if (!s || !s.a) { mode = "tts"; label(); ttsFrom(i, once); return; }
      markSentence(i);
      stopAt = once ? "once" : null;
      const go = () => {
        if (s.clip) audio.currentTime = s.clip[0];
        audio.playbackRate = state.speed;
        return audio.play();
      };
      const same = audio.src && audio.src.endsWith(s.a) && audio.readyState >= 1;
      const ready = same ? Promise.resolve() : new Promise((res, rej) => {
        audio.addEventListener("loadedmetadata", res, { once: true });
        audio.addEventListener("error", rej, { once: true });
        audio.src = s.a;
      });
      ready.then(go).then(() => { audio.playbackRate = state.speed; setPlaying(true); cancelAnimationFrame(raf); raf = requestAnimationFrame(segTick); })
        .catch(() => { mode = "tts"; label(); ttsFrom(i, once); });
    }

    /* صوت المتصفح: جملة جملة مع تظليل الكلمات إن أمكن */
    function ttsFrom(i, once) {
      ttsIdx = i; ttsOnce = once;
      if (i >= total) { finish(); return; }
      markSentence(i);
      fill.style.width = (i / total) * 100 + "%";
      setPlaying(true);
      const s = story.sentences[i];
      speak(s.fr, state.speed, {
        onboundary: (e) => {
          if (e.name && e.name !== "word") return;
          const k = s.parts.findIndex((p) => typeof p !== "string" && e.charIndex >= p._a && e.charIndex < p._b);
          markWord(i, k > -1 ? k : null);
        },
        onend: () => {
          if (!playing || ttsIdx !== i) return;
          markWord(null);
          if (ttsOnce) { setPlaying(false); return; }
          setTimeout(() => { if (playing && ttsIdx === i) ttsFrom(i + 1, false); }, 350);
        },
      });
    }

    const api = {
      toggle() {
        if (playing) return api.pause();
        stopWord();
        if (finished) return api.restart();
        const start = cur > -1 && cur < total ? cur : 0;
        if (mode === "seg") {
          const cs = story.sentences[start];
          const inClip = cs && cs.clip ? audio.currentTime > cs.clip[0] && audio.currentTime < cs.clip[1] : audio.currentTime > 0 && !audio.ended;
          if (audio.src && inClip) { audio.playbackRate = state.speed; audio.play().then(() => { setPlaying(true); raf = requestAnimationFrame(segTick); }).catch(() => {}); }
          else segFrom(audio.ended && start < total - 1 ? start + 1 : start, false);
        } else if (mode === "file") {
          if (audio.currentTime > 0 && !audio.ended && stopAt == null) { audio.playbackRate = state.speed; audio.play().then(() => { setPlaying(true); raf = requestAnimationFrame(tick); }).catch(() => {}); }
          else fileFrom(start, false);
        } else ttsFrom(start, false);
      },
      pause() {
        setPlaying(false);
        clearTimeout(segTimer);
        if (mode === "file" || mode === "seg") audio.pause(); else if (synth) synth.cancel();
      },
      playSentence(i, once) {
        stopWord();
        api.pause();
        if (mode === "seg") segFrom(i, once); else if (mode === "file") fileFrom(i, once); else ttsFrom(i, once);
      },
      step(d) { const i = Math.max(0, Math.min(total - 1, (cur < 0 ? 0 : cur) + d)); api.playSentence(i, false); },
      repeat() { if (finished) return api.restart(); api.playSentence(cur < 0 ? 0 : cur, true); },
      restart() {
        stopWord(); api.pause();
        finished = false; bar.classList.remove("finished"); cur = -1;
        if (audio && mode === "file") audio.currentTime = 0;
        if (mode === "seg") segFrom(0, false); else if (mode === "file") fileFrom(0, false); else ttsFrom(0, false);
        window.scrollTo({ top: 0, behavior: "smooth" });
      },
      seek(frac) {
        if (mode === "file" && audio.duration) {
          audio.currentTime = frac * audio.duration; stopAt = null;
          if (!playing) { const t = audio.currentTime; fill.style.width = frac * 100 + "%"; const si = story.sentences.findIndex((s) => s.ts && t <= s.ts[1]); if (si > -1) markSentence(si); }
        } else api.playSentence(Math.min(total - 1, Math.floor(frac * total)), false);
      },
      setSpeed(v) { if (audio) audio.playbackRate = v; },
      destroy() { api.pause(); if (audio) { audio.removeAttribute("src"); audio.load(); } },
    };
    return api;
  }

  /* ───────── الصفحات ───────── */
  const ICON = {
    play: '<svg class="i-play" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z" fill="currentColor" stroke="none"/></svg>',
    pause: '<svg class="i-pause" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h3v14H7zM14 5h3v14h-3z" fill="currentColor" stroke="none"/></svg>',
    prev: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>',
    next: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>',
    restart: '<svg class="i-restart" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12a8 8 0 1 0 2.3-5.7M4 4v4h4"/></svg>',
    repeat: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12a8 8 0 1 0 2.3-5.7M4 4v4h4"/></svg>',
    speaker: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M16 9a4 4 0 0 1 0 6"/></svg>',
    check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12l5 5L20 7"/></svg>',
    back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>',
  };

  function home() {
    const nx = nextStory();
    const doneN = state.done.size, savedN = Object.keys(state.saved).length;
    const demo = DATA[0] && DATA[0].sentences[0];
    let demoHtml = "";
    if (demo) {
      demoHtml = demo.parts.map((p, k) => typeof p === "string" ? esc(p) : '<button class="w demo-w" data-p="' + k + '">' + esc(p.t) + "</button>").join("");
    }
    const weeks = [1, 2, 3, 4].map((wk) => {
      const list = DATA.filter((s) => s.week === wk);
      const d = list.filter((s) => state.done.has(s.id)).length;
      const cards = list.map((s) => {
        const isDone = state.done.has(s.id), isNext = s === nx && !isDone;
        const st = isDone ? '<span class="st">' + ICON.check + "تمت</span>" : isNext ? '<span class="st">التالية</span>' : "";
        return '<a class="card' + (isDone ? " done" : "") + (isNext ? " next" : "") + '" href="#story-' + s.id + '">' +
          '<div class="card-top"><span>القصة ' + ar(+s.id) + "</span>" + st + "</div>" +
          '<div class="card-fr" lang="fr">' + esc(s.title) + "</div>" +
          '<div class="card-ar">' + esc(s.title_ar) + "</div>" +
          '<p class="card-sum">' + esc(s.summary) + "</p>" +
          '<div class="card-meta">' + ar(s.sentences.length) + " جمل · " + ar(s._new) + " كلمة جديدة</div></a>";
      }).join("");
      return '<section class="week" aria-labelledby="wk' + wk + '"><div class="week-head"><span class="week-n" lang="fr" dir="ltr">Semaine ' + wk + "</span>" +
        '<h2 id="wk' + wk + '">الأسبوع ' + ["", "الأول", "الثاني", "الثالث", "الرابع"][wk] + ": " + WEEKS[wk].title + "</h2>" +
        "<p>" + esc(WEEKS[wk].sub) + "</p>" +
        '<div class="week-bar" aria-label="' + ar(d) + " من " + ar(list.length) + '"><i style="width:' + (list.length ? (d / list.length) * 100 : 0) + '%"></i></div></div>' +
        '<div class="cards">' + cards + "</div></section>";
    }).join("");

    view.innerHTML =
      '<div class="wrap"><section class="hero">' +
        "<div>" +
          '<p class="eyebrow">منهج أساسيات الفرنسية · ٤ أسابيع · ٢٠ قصة</p>' +
          "<h1>تعلّم الفرنسية من <em>القصص</em>، كلمة كلمة.</h1>" +
          '<p class="lead">كل يوم قصة قصيرة عن ليا وأصدقائها في باريس. اضغط على أي كلمة لترى معناها وتسمع نطقها، واستمع إلى القصة كاملة وأنت تتابع النص.</p>' +
          '<div class="hero-cta"><a class="btn btn-ink btn-lg" href="#story-' + nx.id + '">' + (doneN ? "تابع: " : "ابدأ: ") + '<bdi lang="fr">' + esc(nx.title) + "</bdi></a>" +
          (savedN ? '<a class="btn btn-lg" href="#review">راجع كلماتك</a>' : "") + "</div>" +
          '<div class="stats"><div class="stat"><b>' + ar(doneN) + " من " + ar(DATA.length) + "</b><span>قصة مكتملة</span></div>" +
          '<div class="stat"><b>' + ar(savedN) + "</b><span>كلمة محفوظة</span></div>" +
          '<div class="stat"><b>' + ar(dueWords().length) + "</b><span>للمراجعة اليوم</span></div></div>" +
        "</div>" +
        '<div class="sheet demo"><p class="demo-label">جرّب الآن: اضغط على أي كلمة</p>' +
          '<p class="demo-fr" lang="fr">' + demoHtml + "</p>" +
          '<div class="demo-out" id="demo-out" aria-live="polite"><span class="demo-hint">سيظهر المعنى هنا، وستسمع النطق.</span></div>' +
        "</div>" +
      "</section>" +
      '<div class="weeks">' + weeks + "</div></div>";

    view.querySelectorAll(".demo-w").forEach((b) => b.addEventListener("click", () => {
      const p = demo.parts[+b.dataset.p];
      view.querySelectorAll(".demo-w").forEach((x) => x.classList.toggle("sel", x === b));
      $("#demo-out").innerHTML = '<span class="d-word">' + esc(p.t) + (p.l ? " ← " + esc(p.l) : "") + '</span><span class="d-ar">' + esc(p.ar) + "</span>" + (p.n ? '<span class="d-note">' + noteHtml(p.n) + "</span>" : "");
      playWord(p);
    }));
  }

  function grammarHtml(st) {
    const g = st.grammar;
    return '<div class="rule-card"><h3>قاعدة الدرس</h3><h4>' + esc(g.title) + "</h4>" +
      g.paras.map((p) => "<p>" + noteHtml(p) + "</p>").join("") +
      (g.table.length ? '<div class="tbl"><table>' + g.table.map((r) => '<tr><td class="fr-c" lang="fr">' + esc(r[0]) + "</td><td>" + esc(r[1]) + "</td></tr>").join("") + "</table></div>" : "") +
      "</div>";
  }

  function story(id) {
    const st = byId(id);
    if (!st) { location.hash = "home"; return; }
    const idx = DATA.indexOf(st), nx = DATA[idx + 1];
    const sents = st.sentences.map((s, i) => {
      const words = s.parts.map((p, k) => {
        if (typeof p === "string") return esc(p);
        return '<button class="w' + (isSaved(p) ? " saved" : "") + '" data-s="' + i + '" data-p="' + k + '"' + (p.g ? ' data-g="' + p.g + '"' : "") + ">" + esc(p.t) + "</button>";
      }).join("");
      return '<div class="s" data-i="' + i + '">' +
        '<button class="snum" data-play="' + i + '" aria-label="اقرأ من الجملة ' + (i + 1) + '"><span>' + ar(i + 1) + "</span>" + ICON.play + "</button>" +
        '<p class="fr" lang="fr">' + words + ' <button class="tr-btn" data-tr="' + i + '" lang="ar">ترجمة</button></p>' +
        '<p class="ar-line" id="tr' + i + '"' + (state.showTr ? "" : " hidden") + ">" + esc(s.ar) + "</p></div>";
    }).join("");

    view.innerHTML =
      '<div class="wrap reader' + (state.genders ? " genders" : "") + '">' +
        '<header class="story-head"><a class="back" href="#home">' + ICON.back + "كل القصص</a>" +
          '<span class="kicker">الأسبوع ' + ar(st.week) + " · القصة " + ar(+st.id) + " من " + ar(DATA.length) + "</span>" +
          '<h1 lang="fr">' + esc(st.title) + '</h1><div class="sub">' + esc(st.title_ar) + '</div><p class="sum">' + esc(st.summary) + "</p></header>" +
        '<div class="main" style="min-width:0">' +
          '<details class="rule-mobile"><summary>قاعدة الدرس: ' + esc(st.grammar.title) + "</summary>" + grammarHtml(st) + "</details>" +
          '<div class="toolbar">' +
            '<button class="toggle" id="t-tr" aria-pressed="' + state.showTr + '">إظهار الترجمة</button>' +
            '<button class="toggle" id="t-g" aria-pressed="' + state.genders + '">ألوان المذكر والمؤنث</button>' +
            '<span class="legend"><span class="m">— مذكر</span><span class="f">— مؤنث</span></span>' +
          "</div>" +
          '<article class="sheet page" id="page">' + sents + "</article>" +
          '<div class="finish">' +
            (state.done.has(st.id) ? '<span class="btn" aria-disabled="true">' + ICON.check + "أنهيت هذه القصة</span>" : '<button class="btn btn-ink btn-lg" id="mark-done">' + ICON.check + "أنهيت القصة</button>") +
            (nx ? '<a class="btn btn-lg" href="#story-' + nx.id + '">القصة التالية: <bdi lang="fr">' + esc(nx.title) + "</bdi></a>" : '<a class="btn btn-lg" href="#review">إلى المراجعة</a>') +
          "</div>" +
        "</div>" +
        '<aside class="side">' + grammarHtml(st) +
          '<div class="rule-card newwords">في هذه القصة <b>' + ar(st._new) + "</b> كلمة جديدة. اضغط على أي كلمة ثم «احفظ للمراجعة» لتعود إليها لاحقاً.</div>" +
        "</aside>" +
        '<div class="player" role="region" aria-label="مشغّل القصة"><div class="player-in">' +
          '<button class="play-main" id="p-play" aria-label="تشغيل أو إيقاف">' + ICON.play + ICON.pause + ICON.restart + "</button>" +
          '<button class="icon-btn hide-sm" id="p-prev" aria-label="الجملة السابقة">' + ICON.prev + "</button>" +
          '<button class="icon-btn" id="p-rep" aria-label="أعد الجملة">' + ICON.repeat + "</button>" +
          '<button class="icon-btn hide-sm" id="p-next" aria-label="الجملة التالية">' + ICON.next + "</button>" +
          '<div class="prog"><div class="prog-bar" id="p-bar"><i></i></div><div class="prog-txt"><span class="prog-l">' + ar(st.sentences.length) + ' جمل</span><span class="prog-r"></span></div></div>' +
          '<div class="speed" role="group" aria-label="السرعة">' +
            [0.75, 1].map((v) => '<button data-sp="' + v + '" aria-pressed="' + (state.speed === v) + '">' + (v === 1 ? "١×" : "٠٫٧٥×") + "</button>").join("") +
          "</div>" +
        "</div></div>" +
      "</div>";

    const root = $(".reader", view);
    player = makePlayer(st, root);

    root.addEventListener("click", (e) => {
      const w = e.target.closest(".w");
      if (w) {
        const p = st.sentences[+w.dataset.s].parts[+w.dataset.p];
        if (popCtx && popCtx.btn === w) { closePop(); return; }
        openPop(w, p, st, +w.dataset.s);
        return;
      }
      const pl = e.target.closest("[data-play]");
      if (pl) { closePop(); player.playSentence(+pl.dataset.play, false); return; }
      const tr = e.target.closest("[data-tr]");
      if (tr) { const el = $("#tr" + tr.dataset.tr); el.hidden = !el.hidden; return; }
    });
    $("#t-tr").addEventListener("click", (e) => {
      state.showTr = !state.showTr; store.set("showTr", state.showTr);
      e.currentTarget.setAttribute("aria-pressed", state.showTr);
      root.querySelectorAll(".ar-line").forEach((el) => (el.hidden = !state.showTr));
    });
    $("#t-g").addEventListener("click", (e) => {
      state.genders = !state.genders; store.set("genders", state.genders);
      e.currentTarget.setAttribute("aria-pressed", state.genders);
      root.classList.toggle("genders", state.genders);
    });
    $("#p-play").addEventListener("click", () => { closePop(); player.toggle(); });
    $("#p-prev").addEventListener("click", () => player.step(-1));
    $("#p-next").addEventListener("click", () => player.step(1));
    $("#p-rep").addEventListener("click", () => player.repeat());
    $("#p-bar").addEventListener("click", (e) => { const r = e.currentTarget.getBoundingClientRect(); player.seek((e.clientX - r.left) / r.width); });
    root.querySelectorAll("[data-sp]").forEach((b) => b.addEventListener("click", () => {
      state.speed = +b.dataset.sp; store.set("speed", state.speed);
      root.querySelectorAll("[data-sp]").forEach((x) => x.setAttribute("aria-pressed", x === b));
      player.setSpeed(state.speed);
    }));
    const md = $("#mark-done");
    if (md) md.addEventListener("click", () => {
      state.done.add(st.id); saveDone();
      md.outerHTML = '<span class="btn" aria-disabled="true">' + ICON.check + "أنهيت هذه القصة</span>";
      toast(nx ? "أحسنت! القصة التالية بانتظارك" : "أحسنت! أنهيت المنهج كاملاً");
    });
  }

  /* صفحة المراجعة */
  let reviewQueue = [], reviewShown = false;
  function review() {
    const all = Object.entries(state.saved);
    reviewQueue = dueWords().sort(() => Math.random() - 0.5);
    reviewShown = false;
    if (!all.length) {
      view.innerHTML = '<div class="wrap review"><div><h1>المراجعة</h1></div><div class="empty"><h2>لا توجد كلمات محفوظة بعد</h2>' +
        "<p>أثناء قراءة أي قصة، اضغط على كلمة ثم اختر «احفظ للمراجعة». ستظهر هنا في بطاقات، وكلما تذكرتها تباعدت مواعيد مراجعتها.</p>" +
        '<a class="btn btn-ink" href="#story-' + nextStory().id + '">اذهب إلى القصة التالية</a></div></div>';
      return;
    }
    view.innerHTML = '<div class="wrap review"><div><h1>المراجعة</h1><p class="lead">الكلمة التي تتذكرها تعود بعد يوم، ثم يومين، ثم أربعة… والتي تنساها تعود اليوم.</p></div>' +
      '<div id="flash-slot"></div>' +
      '<section><h2 style="font-size:1.15rem;margin-bottom:12px">كل الكلمات المحفوظة (' + ar(all.length) + ")</h2><div class=\"wlist\" id=\"wlist\"></div></section></div>";
    renderFlash();
    renderList();
  }
  function renderList() {
    const el = $("#wlist"); if (!el) return;
    el.innerHTML = Object.entries(state.saved).sort((a, b) => a[1].t.localeCompare(b[1].t, "fr")).map(([id, w]) =>
      '<div class="wrow"><span class="box-dots" aria-label="المستوى ' + w.box + '">' + [1, 2, 3, 4, 5].map((n) => '<i class="' + (w.box >= n ? "on" : "") + '"></i>').join("") + "</span>" +
      '<span class="fr-w" lang="fr">' + esc(w.t) + "</span><span class=\"ar-w\">" + esc(w.ar) + "</span>" +
      '<span style="display:flex;gap:2px"><button class="icon-btn" data-say="' + esc(id) + '" aria-label="استمع">' + ICON.speaker + "</button>" +
      '<button class="icon-btn" data-del="' + esc(id) + '" aria-label="احذف"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button></span></div>').join("");
    el.onclick = (e) => {
      const s = e.target.closest("[data-say]"), d = e.target.closest("[data-del]");
      if (s) playWord(state.saved[s.dataset.say]);
      if (d) { delete state.saved[d.dataset.del]; saveWords(); reviewQueue = reviewQueue.filter((w) => wordId(w) !== d.dataset.del); renderList(); renderFlash(); }
    };
  }
  function renderFlash() {
    const slot = $("#flash-slot"); if (!slot) return;
    const w = reviewQueue[0];
    if (!w) {
      slot.innerHTML = '<div class="empty"><h2>انتهت مراجعة اليوم</h2><p>عُد غداً لمراجعة الكلمات التالية، أو اقرأ قصة جديدة.</p><a class="btn btn-ink" href="#story-' + nextStory().id + '">القصة التالية</a></div>';
      return;
    }
    slot.innerHTML = '<div class="sheet flash">' +
      '<div class="flash-meta"><span>بقي ' + ar(reviewQueue.length) + " للمراجعة</span><span>المستوى " + ar(w.box) + " من ٥</span></div>" +
      '<div class="flash-fr" lang="fr">' + esc(w.t) + ' <button class="icon-btn" id="f-say" aria-label="استمع">' + ICON.speaker + "</button>" +
      (w.g ? '<span class="chip ' + w.g + '">' + (w.g === "f" ? "مؤنث" : "مذكر") + "</span>" : "") + "</div>" +
      (w.ctx ? '<p class="flash-ctx" lang="fr">« ' + esc(w.ctx) + " »</p>" : "") +
      '<div id="f-back" hidden><div class="flash-ar">' + esc(w.ar) + "</div>" + (w.l && w.l !== w.t ? '<p class="pop-lemma">الأصل: <span>' + esc(w.l) + "</span></p>" : "") + (w.n ? '<p class="pop-note">' + noteHtml(w.n) + "</p>" : "") + "</div>" +
      '<div class="flash-actions" id="f-act"><button class="btn btn-ink btn-lg" id="f-show">اكشف المعنى</button></div></div>';
    $("#f-say").onclick = () => playWord(w);
    $("#f-show").onclick = () => {
      $("#f-back").hidden = false;
      $("#f-act").innerHTML = '<button class="btn btn-lg" id="f-no">لم أتذكرها</button><button class="btn btn-ink btn-lg" id="f-yes">تذكرتها</button>';
      $("#f-yes").onclick = () => grade(true);
      $("#f-no").onclick = () => grade(false);
    };
    playWord(w);
  }
  function grade(ok) {
    const w = reviewQueue.shift(), id = wordId(w), rec = state.saved[id];
    if (rec) {
      rec.box = ok ? Math.min(5, rec.box + 1) : 0;
      rec.due = today() + (ok ? INTERVALS[rec.box] : 0);
      saveWords();
    }
    if (!ok) reviewQueue.push(w);
    renderFlash(); renderList();
  }

  /* ───────── التوجيه ───────── */
  function route() {
    closePop();
    if (player) { player.destroy(); player = null; }
    if (synth) synth.cancel();
    const h = location.hash.replace(/^#\/?/, "");
    let page = "home";
    if (h.startsWith("story-")) { page = "story"; story(h.slice(6)); }
    else if (h === "review") { page = "review"; review(); }
    else home();
    document.querySelectorAll("[data-nav]").forEach((a) => a.classList.toggle("on", a.dataset.nav === page));
    window.scrollTo(0, 0);
    updateBadge();
  }
  window.addEventListener("hashchange", route);
  window.addEventListener("keydown", (e) => {
    if (!player || e.target.closest("input, textarea")) return;
    if (e.code === "Space" && !e.target.closest("button, a")) { e.preventDefault(); player.toggle(); }
  });

  if (!DATA.length) {
    view.innerHTML = '<div class="wrap"><div class="empty" style="margin-top:40px"><h2>لم أجد بيانات القصص</h2><p>شغّل <code dir="ltr">python tools/build.py</code> لإنشاء الملف <code dir="ltr">data/bundle.js</code>.</p></div></div>';
  } else route();
})();
