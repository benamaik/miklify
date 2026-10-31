// Безопасный мост между окном интерфейса и основным процессом.
const { contextBridge, ipcRenderer } = require('electron');

const EVENTS = new Set(['library:updated', 'scan:progress', 'recognize:progress', 'cmd', 'window:visible']);

contextBridge.exposeInMainWorld('api', {
  init: () => ipcRenderer.invoke('init'),
  setState: (patch) => ipcRenderer.send('state:set', patch),
  addFolders: () => ipcRenderer.invoke('folders:add'),
  removeFolder: (folder) => ipcRenderer.invoke('folders:remove', folder),
  rescan: () => ipcRenderer.invoke('library:rescan'),
  nowPlaying: (text, playing) => ipcRenderer.send('player:now', text, playing),
  recognizeStatus: () => ipcRenderer.invoke('recognize:status'),
  recognize: () => ipcRenderer.invoke('recognize:start'),
  cancelRecognize: () => ipcRenderer.send('recognize:cancel'),
  retryRecognize: () => ipcRenderer.invoke('recognize:retry'),
  openAcoustid: () => ipcRenderer.invoke('open:acoustid'),
  onlineStatus: () => ipcRenderer.invoke('online:status'),
  jamendoSearch: (q) => ipcRenderer.invoke('jamendo:search', q),
  radioSearch: (q) => ipcRenderer.invoke('radio:search', q),
  lyrics: (t) => ipcRenderer.invoke('lyrics:get', t),
  youtubeSearch: (q, region, channelId) => ipcRenderer.invoke('youtube:search', q, region, channelId),
  youtubeRefresh: (ids, region) => ipcRenderer.invoke('youtube:refresh', ids, region),
  ytPort: () => ipcRenderer.invoke('yt:port'),
  radioClick: (uuid) => ipcRenderer.send('radio:click', uuid),
  download: (track) => ipcRenderer.invoke('online:download', track),
  sharePick: () => ipcRenderer.invoke('share:pick'),
  shareRead: (p, offset, len) => ipcRenderer.invoke('share:read', p, offset, len),
  shareSave: (name, bytes) => ipcRenderer.invoke('share:save', name, bytes),
  openUrl: (url) => ipcRenderer.invoke('open:url', url),
  on: (channel, cb) => {
    if (EVENTS.has(channel)) ipcRenderer.on(channel, (_e, ...args) => cb(...args));
  },
});
