// Мост между официальным плеером YouTube (IFrame API) и интерфейсом Miklify.
// Команды приходят от родительского окна через postMessage, состояние уходит обратно.
let player = null;
let ready = false;
const pending = [];          // команды, пришедшие до готовности плеера
const parentWin = window.parent;

const send = (msg) => parentWin.postMessage({ miklifyYt: true, ...msg }, '*');

function run(cmd) {
  switch (cmd.cmd) {
    case 'load':
      if (cmd.autoplay) player.loadVideoById({ videoId: cmd.id, startSeconds: cmd.start || 0 });
      else player.cueVideoById({ videoId: cmd.id, startSeconds: cmd.start || 0 });
      break;
    case 'play': player.playVideo(); break;
    case 'pause': player.pauseVideo(); break;
    case 'stop': player.stopVideo(); break;
    case 'seek': player.seekTo(cmd.t, true); break;
    case 'volume': player.setVolume(Math.round(cmd.v * 100)); break;
  }
}

window.addEventListener('message', (e) => {
  if (e.source !== parentWin || !e.data || !e.data.miklifyYt) return;
  if (ready) run(e.data); else pending.push(e.data);
});

window.onYouTubeIframeAPIReady = () => {
  player = new YT.Player('p', {
    width: '100%',
    height: '100%',
    // Свои кнопки у нас внизу окна, поэтому убираем панель управления YouTube (шестерёнку, полноэкранный режим,
    // затемнение), подсказки поверх видео и горячие клавиши внутри iframe. Это штатные параметры плеера.
    playerVars: {
      playsinline: 1, rel: 0, enablejsapi: 1, origin: location.origin,
      controls: 0, fs: 0, disablekb: 1, iv_load_policy: 3, cc_load_policy: 0,
    },
    events: {
      onReady() {
        ready = true;
        send({ type: 'ready' });
        pending.splice(0).forEach(run);
      },
      onStateChange(e) { send({ type: 'state', state: e.data }); },
      onError(e) { send({ type: 'error', code: e.data }); },
    },
  });
};

// Позиция и длительность — несколько раз в секунду
setInterval(() => {
  if (!ready || !player.getCurrentTime) return;
  send({
    type: 'time', t: player.getCurrentTime(), d: player.getDuration(), state: player.getPlayerState(),
    id: player.getVideoData?.().video_id, // чтобы не приписать длительность прошлого ролика новому треку
  });
}, 400);

// API YouTube загружается с его серверов (так требуют правила)
const s = document.createElement('script');
s.src = 'https://www.youtube.com/iframe_api';
document.head.appendChild(s);
