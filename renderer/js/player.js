// Плеер: очередь, воспроизведение, перемешивание, повтор, сохранение состояния.
// Состояние отдаёт через событие 'player:update' на document.
const Player = (() => {
  const audio = new Audio();
  audio.preload = 'auto';

  let queue = [];     // id треков
  let index = -1;     // позиция в очереди
  let history = [];   // индексы уже сыгранных (для «Назад» в режиме shuffle)
  let played = new Set(); // сыгранные в текущем круге перемешивания
  let shuffle = false;
  let repeat = 'off'; // off | all | one
  let errorStreak = 0;
  let lastSavedPos = 0;
  let analyser = null, freq = null;
  // Режим YouTube: играет встроенный плеер YouTube, а не <audio>
  let ytMode = false;
  let yt = { playing: false, t: 0, d: 0 };
  let getTrack = () => null; // подставляется из app.js: id -> трек
  let onUse = () => {};      // сообщает app.js, какие треки попали в очередь (чтобы запомнить онлайн-треки)
  let onDuration = () => {}; // сообщает app.js настоящую длительность трека, у которого её не было
  let isBlocked = () => false; // app.js: известно ли, что YouTube не даёт играть этот трек
  let onBlocked = () => {};    // app.js запоминает ролик, который плеер YouTube отказался играть

  // Плавное затухание при паузе и переключении
  const FADE_MS = 280;
  const FADE_IN_MS = 160;
  let fader = null;          // узел громкости для затуханий (не трогает настройку громкости)
  let fadeTimer = 0;         // идёт затухание
  let fadeDone = null;       // что сделать, когда стихнет (берётся последнее — на случай частых переключений)
  let pausing = false;       // пауза уже нажата, звук ещё стихает
  let ytRamp = 0;            // таймер плавной громкости YouTube
  let ytLevel = 0.8;         // текущая громкость YouTube, 0..1
  // Правила YouTube запрещают играть в фоне: пока окно скрыто или свёрнуто, YouTube стоит на паузе
  let windowVisible = true;
  let ytResume = false;      // YouTube остановлен из-за скрытого окна — продолжить, когда окно вернётся

  // Эквалайзер: 10 полос, усиление −12…+12 дБ
  const EQ_FREQS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
  let eq = { on: true, preset: 'flat', gains: EQ_FREQS.map(() => 0) };
  let filters = [];
  let preamp = null;

  const emit = () => document.dispatchEvent(new CustomEvent('player:update'));
  const persist = () => api.setState({ queue, qi: index, shuffle, repeat });

  function current() { return index >= 0 ? getTrack(queue[index]) : null; }

  // Звуковой граф: источник → предусилитель → фильтры EQ → анализатор → выход.
  // Создаётся при первом воспроизведении.
  function ensureAnalyser() {
    if (analyser) return;
    try {
      const ac = new (window.AudioContext || window.webkitAudioContext)();
      const src = ac.createMediaElementSource(audio);
      preamp = ac.createGain();
      filters = EQ_FREQS.map((f, i) => {
        const b = ac.createBiquadFilter();
        b.type = i === 0 ? 'lowshelf' : i === EQ_FREQS.length - 1 ? 'highshelf' : 'peaking';
        b.frequency.value = f;
        b.Q.value = 1.1;
        return b;
      });
      analyser = ac.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.8;
      fader = ac.createGain();
      let node = src.connect(preamp);
      for (const f of filters) node = node.connect(f);
      node.connect(fader).connect(analyser);
      analyser.connect(ac.destination);
      freq = new Uint8Array(analyser.frequencyBinCount);
      applyEq();
    } catch { analyser = null; }
  }

  // Применить настройки EQ к фильтрам (плавно, без щелчков)
  function applyEq() {
    if (!filters.length) return;
    const now = filters[0].context.currentTime;
    filters.forEach((f, i) => f.gain.setTargetAtTime(eq.on ? eq.gains[i] : 0, now, 0.04));
    // При подъёме полос немного снижаем общий уровень, чтобы не было перегруза
    const boost = eq.on ? Math.max(0, ...eq.gains) : 0;
    preamp.gain.setTargetAtTime(Math.pow(10, -boost / 40), now, 0.04);
  }

  // Громкость низких частот 0..1
  function energy() {
    if (ytMode || !analyser || audio.paused) return 0;
    analyser.getByteFrequencyData(freq);
    let sum = 0;
    for (let i = 0; i < 8; i++) sum += freq[i];
    return Math.min(1, sum / 8 / 255 * 1.3);
  }

  // ----- плавная громкость -----
  function rampFader(value, ms) {
    if (!fader) return;
    const g = fader.gain, now = fader.context.currentTime;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(value, now + ms / 1000);
  }

  // К звуку YouTube доступа нет, поэтому плавно двигаем его собственную громкость
  function rampYtVolume(to, ms) {
    clearInterval(ytRamp);
    const from = ytLevel, t0 = performance.now();
    ytRamp = setInterval(() => {
      const k = Math.min(1, (performance.now() - t0) / ms);
      ytLevel = from + (to - from) * k;
      Yt.volume(ytLevel);
      if (k >= 1) { clearInterval(ytRamp); ytRamp = 0; }
    }, 30);
  }

  // Стихнуть и выполнить done. Повторный вызов во время затухания только заменяет done:
  // при быстром листании включится последний выбранный трек, а звук не будет дёргаться.
  function fadeOut(done) {
    fadeDone = done;
    if (fadeTimer) return;
    if (ytMode) rampYtVolume(0, FADE_MS);
    else if (fader) rampFader(0, FADE_MS);
    else { fadeDone = null; done(); return; }
    fadeTimer = setTimeout(() => {
      fadeTimer = 0;
      const d = fadeDone;
      fadeDone = null;
      if (d) d();
    }, FADE_MS);
  }

  function cancelFade() {
    clearTimeout(fadeTimer);
    fadeTimer = 0;
    fadeDone = null;
    pausing = false;
  }

  function fadeIn() {
    if (ytMode) rampYtVolume(audio.volume, FADE_IN_MS);
    else rampFader(1, FADE_IN_MS);
  }

  // Трек без записанной длительности: берём её у плеера и запоминаем
  function learnDuration(d) {
    const t = current();
    if (t && !t.duration && !t.live && d > 0 && isFinite(d)) {
      t.duration = Math.round(d);
      onDuration(t);
    }
  }

  // Сменить трек: если что-то звучит — сначала даём ему стихнуть.
  // Индекс и название меняем сразу, чтобы интерфейс и повторные нажатия не ждали затухания.
  function load(i, { autoplay = true, pos = 0 } = {}) {
    const t = getTrack(queue[i]);
    if (!t) return;
    // Явный запуск трека, который YouTube не играет: не пытаемся и не ждём ошибки
    if (autoplay && isBlocked(t)) {
      UI.toast(`YouTube не разрешает играть «${t.title}» вне своего сайта`);
      return;
    }
    index = i;
    const audible = ytMode ? yt.playing : !audio.paused && !audio.ended;
    if (autoplay && audible) fadeOut(() => startTrack(t, autoplay, pos));
    else { cancelFade(); startTrack(t, autoplay, pos); }
    persist();
    emit();
  }

  function startTrack(t, autoplay, pos) {
    pausing = false;
    clearInterval(ytRamp);
    ytRamp = 0;
    if (t.online === 'youtube') {
      audio.pause();
      ytMode = true;
      const play = autoplay && windowVisible;
      if (autoplay && !play) ytResume = true; // очередь дошла до YouTube при скрытом окне
      yt = { playing: play, t: pos, d: t.duration || 0 };
      ytLevel = audio.volume;
      Yt.show(true);
      Yt.volume(ytLevel);
      Yt.load(t.videoId, { autoplay: play, start: t.live ? 0 : pos });
      emit();
      return;
    }
    if (ytMode) { ytMode = false; Yt.stop(); Yt.show(false); }
    // Сетевым потокам нужен CORS-режим, иначе Web Audio (эквалайзер) получит тишину
    audio.crossOrigin = /^https?:/.test(t.url) ? 'anonymous' : null;
    audio.src = t.url;
    if (pos > 0 && !t.live) audio.addEventListener('loadedmetadata', () => { audio.currentTime = pos; }, { once: true });
    if (autoplay) {
      ensureAnalyser();
      rampFader(1, FADE_IN_MS);
      audio.play().catch(() => {});
      if (t.live && t.uuid) api.radioClick(t.uuid);
    }
    emit();
  }

  // Следующий индекс. В режиме перемешивания каждый трек играет один раз за круг;
  // когда все сыграны — возвращаем queue.length, то есть «очередь закончилась».
  function pickNext(from = index) {
    if (shuffle && queue.length > 1) {
      played.add(from);
      const left = queue.map((_, i) => i).filter((i) => !played.has(i));
      return left.length ? left[Math.floor(Math.random() * left.length)] : queue.length;
    }
    return from + 1;
  }

  // Трек очереди, который YouTube уже отказался играть
  const blockedAt = (i) => isBlocked(getTrack(queue[i]));

  // Остановиться в начале текущего трека (дальше по очереди идти некуда)
  function stopAtStart(fade = false) {
    const stop = () => {
      pausing = false;
      if (ytMode) { Yt.pause(); Yt.seek(0); yt.playing = false; yt.t = 0; }
      else { audio.pause(); audio.currentTime = 0; }
      emit();
    };
    if (!fade || !api_.playing) { stop(); return; }
    pausing = true;
    if (ytMode) yt.playing = false;
    fadeOut(stop);
    emit();
  }

  // Вернуться к началу текущего трека (и играть, если нужно)
  function restart(play) {
    if (ytMode) { Yt.seek(0); yt.t = 0; if (play) { Yt.play(); yt.playing = true; } emit(); return; }
    audio.currentTime = 0;
    if (play) audio.play().catch(() => {});
  }

  const api_ = {
    audio,
    get queue() { return queue; },
    get index() { return index; },
    get shuffle() { return shuffle; },
    get repeat() { return repeat; },
    get playing() { return ytMode ? yt.playing : !audio.paused && !pausing; },
    get currentTime() { return ytMode ? yt.t : audio.currentTime; },
    get duration() { return ytMode ? yt.d : audio.duration; },
    current,
    energy,

    init({ getTrackFn, state, onUseFn, onDurationFn, isBlockedFn, onBlockedFn }) {
      getTrack = getTrackFn;
      if (onUseFn) onUse = onUseFn;
      if (onDurationFn) onDuration = onDurationFn;
      if (isBlockedFn) isBlocked = isBlockedFn;
      if (onBlockedFn) onBlocked = onBlockedFn;
      shuffle = !!state.shuffle;
      repeat = state.repeat || 'off';
      audio.volume = state.volume ?? 0.8;
      if (state.eq && state.eq.gains?.length === EQ_FREQS.length) eq = { ...eq, ...state.eq };
      queue = (state.queue || []).filter((id) => getTrack(id));
      // индекс мог сместиться, если часть треков пропала из библиотеки
      const savedId = (state.queue || [])[state.qi];
      index = savedId ? queue.indexOf(savedId) : -1;
      if (index >= 0) load(index, { autoplay: false, pos: state.pos || 0 });

      audio.addEventListener('play', emit);
      audio.addEventListener('pause', emit);
      audio.addEventListener('timeupdate', () => {
        document.dispatchEvent(new CustomEvent('player:time'));
        // позицию сохраняем не чаще раза в 5 секунд
        if (Math.abs(audio.currentTime - lastSavedPos) >= 5) {
          lastSavedPos = audio.currentTime;
          api.setState({ pos: audio.currentTime });
        }
      });
      audio.addEventListener('ended', () => { if (!fadeTimer) api_.next(true); });
      audio.addEventListener('loadedmetadata', () => { if (!ytMode) learnDuration(audio.duration); });
      audio.addEventListener('playing', () => { errorStreak = 0; });
      audio.addEventListener('error', () => {
        if (ytMode) return; // у YouTube свои ошибки
        // файл удалён/недоступен — пропускаем, но не зацикливаемся
        const t = current();
        UI.toast(`Не удалось воспроизвести: ${t ? t.title : 'файл'}`);
        if (++errorStreak < 5 && queue.length > 1) api_.next(true);
      });

      // События встроенного плеера YouTube
      Yt.on({
        state(playing) {
          if (!ytMode) return;
          if (fadeTimer) return; // во время затухания состояние меняем сами
          if (playing) {
            errorStreak = 0;
            if (!ytRamp) { ytLevel = audio.volume; Yt.volume(ytLevel); } // пауза могла оставить громкость на нуле
          }
          if (yt.playing !== playing) { yt.playing = playing; emit(); }
        },
        ended() { if (ytMode && !fadeTimer) api_.next(true); },
        time(t, d, id) {
          if (!ytMode || id !== current()?.videoId) return; // ещё идёт прошлый ролик
          yt.t = t;
          if (d) { yt.d = d; learnDuration(d); }
          document.dispatchEvent(new CustomEvent('player:time'));
          if (Math.abs(t - lastSavedPos) >= 5) { lastSavedPos = t; api.setState({ pos: t }); }
        },
        error(code) {
          if (!ytMode) return;
          const t = current();
          // 100 — ролик удалён или закрыт, 101/150/153 — автор запретил встраивание. Запоминаем: в следующий раз
          // плеер пропустит его сразу, а из результатов поиска он пропадёт.
          const blocked = [100, 101, 150, 153].includes(code);
          if (blocked && t) onBlocked(t, code);
          UI.toast(blocked ? `YouTube не разрешает играть «${t ? t.title : 'это видео'}» вне своего сайта`
            : `Видео недоступно: ${t ? t.title : ''}`);
          yt.playing = false;
          emit();
          if (++errorStreak < 5 && queue.length > 1) api_.next(true);
        },
      });
    },

    // Окно скрыли или вернули
    setWindowVisible(v) {
      windowVisible = v;
      if (!v) {
        if (ytMode && yt.playing) { ytResume = true; api_.toggle(); }
      } else if (ytResume) {
        ytResume = false;
        if (ytMode && !yt.playing) api_.toggle();
      }
    },

    // Запустить список треков с позиции idx
    playList(ids, idx = 0) {
      onUse(ids);
      queue = [...ids];
      history = []; played.clear();
      // Если выбранный трек YouTube не играет, начинаем со следующего доступного
      let start = idx;
      for (let g = 0; start < queue.length && blockedAt(start) && g < queue.length; g++) start++;
      if (start >= queue.length) start = idx; // доступных нет — load() сам скажет об этом
      load(start);
    },
    playIndex(i) { history.push(index); load(i); },

    toggle() {
      if (index < 0) {
        if (queue.length) load(0);
        return;
      }
      // Медиаклавиши и трей работают и при скрытом окне, но YouTube в фоне запускать нельзя
      if (ytMode && !windowVisible && !yt.playing) return;
      // Нажали снова, пока звук стихал, — передумали ставить на паузу
      if (pausing) {
        cancelFade();
        if (ytMode) yt.playing = true;
        fadeIn();
        emit();
        return;
      }
      if (ytMode) {
        if (yt.playing) {
          pausing = true;
          yt.playing = false;
          fadeOut(() => { pausing = false; Yt.pause(); });
        } else {
          yt.playing = true;
          Yt.play();
          fadeIn();
        }
        emit();
        return;
      }
      if (audio.paused) {
        ensureAnalyser();
        fadeIn();
        audio.play().catch(() => {});
      } else {
        pausing = true;
        fadeOut(() => { pausing = false; audio.pause(); });
        emit();
      }
    },

    next(auto = false) {
      if (!queue.length) return;
      if (auto && repeat === 'one') { restart(true); return; }
      let n = pickNext();
      // Пропускаем треки, которые YouTube не играет
      for (let guard = 0; n < queue.length && blockedAt(n) && guard < queue.length; guard++) n = pickNext(n);
      if (n >= queue.length) {
        // Конец очереди: по кругу только при «повторять всё», иначе стоп — и при авто-переходе, и по кнопке
        if (repeat !== 'all') { stopAtStart(!auto); return; }
        played.clear();
        n = shuffle && queue.length > 1 ? Math.floor(Math.random() * queue.length) : 0;
      }
      history.push(index);
      load(n);
    },

    prev() {
      if (!queue.length) return;
      const hasPrev = history.length > 0 || index > 0 || repeat === 'all';
      // Предыдущего нет (начало плейлиста) — останавливаемся, а не прыгаем в конец
      if (!hasPrev) { stopAtStart(true); return; }
      // Если трек играет дольше 3 секунд — сначала возвращаемся к его началу
      if (api_.currentTime > 3) { restart(false); return; }
      let p = history.length ? history.pop() : (index > 0 ? index - 1 : queue.length - 1);
      // Назад тоже обходим недоступные треки; если до начала все такие — остаёмся на месте
      for (let guard = 0; blockedAt(p) && guard < queue.length; guard++) {
        p = history.length ? history.pop() : p - 1;
        if (p < 0) { stopAtStart(true); return; }
      }
      played.delete(p);
      load(p);
    },

    seek(sec) {
      if (ytMode) {
        if (!yt.d) return;
        yt.t = Math.min(Math.max(0, sec), yt.d);
        Yt.seek(yt.t);
        document.dispatchEvent(new CustomEvent('player:time'));
        return;
      }
      if (isFinite(audio.duration)) audio.currentTime = Math.min(Math.max(0, sec), audio.duration);
    },
    seekBy(d) { api_.seek(api_.currentTime + d); },

    get volume() { return audio.volume; },
    setVolume(v) {
      audio.volume = Math.min(1, Math.max(0, v));
      if (ytMode && !ytRamp) { ytLevel = audio.volume; Yt.volume(ytLevel); }
      api.setState({ volume: audio.volume });
      emit();
    },

    // ----- эквалайзер -----
    EQ_FREQS,
    get eq() { return eq; },
    setEq(patch) {
      eq = { ...eq, ...patch, gains: [...(patch.gains || eq.gains)] };
      applyEq();
      api.setState({ eq });
    },

    toggleShuffle() { shuffle = !shuffle; played.clear(); persist(); emit(); },
    cycleRepeat() { repeat = { off: 'all', all: 'one', one: 'off' }[repeat]; persist(); emit(); },

    // ----- операции с очередью -----
    addNext(ids) {
      if (!queue.length) { api_.playList(ids, 0); return; }
      onUse(ids);
      queue.splice(index + 1, 0, ...ids);
      history = []; played.clear(); persist(); emit();
    },
    addEnd(ids) {
      if (!queue.length) { api_.playList(ids, 0); return; }
      onUse(ids);
      queue.push(...ids);
      persist(); emit();
    },
    removeAt(i) {
      if (i === index) return; // играющий трек не удаляем
      queue.splice(i, 1);
      if (i < index) index--;
      history = []; played.clear(); persist(); emit();
    },
    move(from, to) {
      if (from === to) return;
      const [id] = queue.splice(from, 1);
      queue.splice(to, 0, id);
      if (from === index) index = to;
      else if (from < index && to >= index) index--;
      else if (from > index && to <= index) index++;
      history = []; played.clear(); persist(); emit();
    },
    clearUpcoming() {
      queue = queue.slice(0, index + 1);
      history = []; played.clear(); persist(); emit();
    },
    // Убрать из очереди треки, которых больше нет в библиотеке
    prune() {
      const curId = queue[index];
      queue = queue.filter((id) => getTrack(id));
      index = curId ? queue.indexOf(curId) : -1;
      history = []; played.clear(); persist();
      // Играющий ролик YouTube удалён (например, по кнопке в настройках)
      if (ytMode && index < 0) { ytMode = false; yt.playing = false; Yt.stop(); Yt.show(false); emit(); }
    },
  };
  return api_;
})();
