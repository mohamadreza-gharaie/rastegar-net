/* رستگار نت — صفحهٔ کلاس: تماس تصویری/صوتی گروهی (WebRTC)، اشتراک صفحه، گفتگو، کنترل معلم */
(function () {
  'use strict';

  var RN = window.RN, h = RN.h, icon = RN.icon, toast = RN.toast, $ = RN.$;
  var cfg = JSON.parse($('#cfg').textContent);
  var IS_TEACHER = cfg.role === 'teacher';
  var RTC_CONFIG = { iceServers: cfg.ice || [] };

  var PERM_LABELS = { mic: 'میکروفن', cam: 'دوربین', chat: 'گفتگو', screen: 'اشتراک صفحه' };
  var SWITCH_LABELS = {
    mic: 'میکروفن دانش‌آموزان',
    cam: 'دوربین دانش‌آموزان',
    chat: 'گفتگو (چت) دانش‌آموزان',
    screen: 'اشتراک صفحه توسط دانش‌آموزان'
  };

  /* ───────── وضعیت ───────── */
  var socket = null, me = null, joinName = '';
  var perms = { mic: true, cam: true, chat: true, screen: true };
  var wantMic = true, wantCam = true;           // انتخاب کاربر پیش از ورود
  var micOn = false, camOn = false, sharing = false;
  var audioTrack = null, videoTrack = null, screenStream = null;
  var peers = new Map();                        // sid -> {pc, stream, aSender, vSender, pending, initiator}
  var pendingCand = new Map();                  // ICE هایی که پیش از آفر رسیده‌اند
  var info = new Map();                         // sid -> مشخصات عمومی (نام، نقش، mic, cam, screen)
  var tiles = new Map();                        // sid -> {el, video, ...}
  var roomState = null;                         // فقط معلم
  var finished = false, unread = 0, activeTab = 'chat';

  var hasMedia = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  var hasDisplay = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
  var AUDIO_C = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  var VIDEO_C = { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 24, max: 30 } };

  /* ───────── پیش از ورود ───────── */
  var pre = { video: $('#pre-video'), off: $('#pre-off'), mic: $('#pre-mic'), cam: $('#pre-cam'), note: $('#pre-note') };

  function preNote(msg) { pre.note.textContent = msg; pre.note.hidden = !msg; }

  function liveVideo() { return videoTrack && videoTrack.readyState === 'live' ? videoTrack : null; }

  function updatePre() {
    var camAvail = !!liveVideo(), micAvail = !!audioTrack;
    pre.cam.disabled = !camAvail;
    pre.mic.disabled = !micAvail;
    wantCam = wantCam && camAvail;
    wantMic = wantMic && micAvail;
    setCtl(pre.mic, { on: wantMic, icon: wantMic ? 'mic' : 'mic-off', label: micAvail ? (wantMic ? 'میکروفن روشن' : 'میکروفن خاموش') : 'میکروفن در دسترس نیست' });
    setCtl(pre.cam, { on: wantCam, icon: wantCam ? 'cam' : 'cam-off', label: camAvail ? (wantCam ? 'دوربین روشن' : 'دوربین خاموش') : 'دوربین در دسترس نیست' });
    pre.video.srcObject = camAvail ? new MediaStream([videoTrack]) : null;
    pre.video.hidden = !(camAvail && wantCam);
    pre.off.hidden = camAvail && wantCam;
  }

  function setCtl(btn, s) {
    btn.classList.toggle('on', !!s.on && !s.locked);
    btn.classList.toggle('off', !s.on && !s.locked && !s.neutral);
    btn.classList.toggle('locked', !!s.locked);
    btn.classList.toggle('active', !!s.active);
    btn.setAttribute('aria-pressed', s.on ? 'true' : 'false');
    var use = btn.querySelector('use');
    if (use && s.icon) use.setAttribute('href', '#i-' + s.icon);
    var span = btn.querySelector('span');
    if (span && s.label) span.textContent = s.label;
  }

  function initialMedia() {
    if (!hasMedia) {
      preNote('این مرورگر اجازهٔ استفاده از دوربین و میکروفن را نمی‌دهد. اگر سایت را با آدرس http باز کرده‌اید، باید از https یا localhost استفاده کنید. فقط با گفتگو می‌توانید وارد شوید.');
      updatePre();
      return Promise.resolve();
    }
    var gum = function (c) { return navigator.mediaDevices.getUserMedia(c); };
    return gum({ audio: AUDIO_C, video: VIDEO_C })
      .catch(function () {
        return gum({ audio: AUDIO_C }).then(function (s) { preNote('دوربین در دسترس نیست؛ با صدا وارد می‌شوید.'); return s; });
      })
      .catch(function () {
        return gum({ video: VIDEO_C }).then(function (s) { preNote('میکروفن در دسترس نیست؛ فقط می‌توانید تصویر بفرستید.'); return s; });
      })
      .then(function (s) {
        audioTrack = s.getAudioTracks()[0] || null;
        videoTrack = s.getVideoTracks()[0] || null;
      })
      .catch(function () {
        preNote('دسترسی به دوربین و میکروفن ممکن نشد. در تنظیمات مرورگر اجازه بدهید، یا فقط با گفتگو وارد شوید.');
      })
      .then(updatePre);
  }

  pre.mic.addEventListener('click', function () { wantMic = !wantMic; updatePre(); });
  pre.cam.addEventListener('click', function () { wantCam = !wantCam; updatePre(); });

  if (IS_TEACHER) {
    try { $('#pre-name').value = localStorage.getItem('rn_teacher_name') || ''; } catch (e) { /* ignore */ }
  }

  $('#join-btn').addEventListener('click', function () {
    joinName = IS_TEACHER ? ($('#pre-name').value.trim() || 'معلم') : cfg.name;
    if (IS_TEACHER) { try { localStorage.setItem('rn_teacher_name', joinName); } catch (e) { /* ignore */ } }
    $('#join-btn').disabled = true;
    $('#join-btn').textContent = 'در حال ورود…';
    connect();
  });

  initialMedia();

  /* ───────── رسانهٔ محلی ───────── */
  function currentVideoTrack() {
    if (sharing && screenStream) return screenStream.getVideoTracks()[0] || null;
    return camOn ? liveVideo() : null;
  }

  function syncSenders() {
    var v = currentVideoTrack();
    peers.forEach(function (e) {
      if (e.aSender) e.aSender.replaceTrack(audioTrack || null).catch(function () {});
      if (e.vSender) e.vSender.replaceTrack(v || null).catch(function () {});
    });
  }

  function acquire(kind) {
    var c = kind === 'audio' ? { audio: AUDIO_C } : { video: VIDEO_C };
    return navigator.mediaDevices.getUserMedia(c).then(function (s) { return s.getTracks()[0] || null; }).catch(function () { return null; });
  }

  function setMic(on, silent) {
    if (on && !perms.mic) { if (!silent) toast('معلم میکروفن را بسته است.', 'warn'); on = false; }
    var step = Promise.resolve();
    if (on && !audioTrack && hasMedia) {
      step = acquire('audio').then(function (t) {
        audioTrack = t;
        if (t) syncSenders(); else if (!silent) toast('میکروفن در دسترس نیست.', 'warn');
      });
    }
    return step.then(function () {
      micOn = on && !!audioTrack;
      if (audioTrack) audioTrack.enabled = micOn;
      reportMedia();
      updateControls();
    });
  }

  function setCam(on, silent) {
    if (on && !perms.cam) { if (!silent) toast('معلم دوربین را بسته است.', 'warn'); on = false; }
    var step = Promise.resolve();
    if (on) {
      if (!liveVideo() && hasMedia) {
        step = acquire('video').then(function (t) {
          videoTrack = t;
          if (!t && !silent) toast('دوربین در دسترس نیست.', 'warn');
        });
      }
    } else if (videoTrack) {
      videoTrack.stop();       // چراغ دوربین واقعاً خاموش شود
      videoTrack = null;
    }
    return step.then(function () {
      camOn = on && !!liveVideo();
      syncSenders();
      updateLocalPreview();
      reportMedia();
      updateControls();
    });
  }

  function startShare() {
    if (!perms.screen) { toast('معلم اجازهٔ اشتراک صفحه را نداده است.', 'warn'); return; }
    if (!hasDisplay) { toast('این مرورگر یا دستگاه از اشتراک صفحه پشتیبانی نمی‌کند.', 'warn'); return; }
    navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 15, max: 30 } }, audio: false })
      .then(function (s) {
        screenStream = s;
        var t = s.getVideoTracks()[0];
        if (t && 'contentHint' in t) t.contentHint = 'detail';
        if (t) t.addEventListener('ended', stopShare);
        sharing = true;
        syncSenders();
        updateLocalPreview();
        socket.emit('screen_state', { on: true });
        patchLocalInfo();
        updateControls();
      })
      .catch(function () { /* کاربر انصراف داد */ });
  }

  function stopShare() {
    if (!sharing) return;
    if (screenStream) screenStream.getTracks().forEach(function (t) { t.stop(); });
    screenStream = null;
    sharing = false;
    syncSenders();
    updateLocalPreview();
    if (socket) socket.emit('screen_state', { on: false });
    patchLocalInfo();
    updateControls();
  }

  function reportMedia() {
    if (socket && socket.connected && me) socket.emit('media_state', { mic: micOn, cam: camOn });
    patchLocalInfo();
  }

  function patchLocalInfo() {
    if (!me) return;
    var p = info.get(me.sid);
    if (!p) return;
    p.mic = micOn; p.cam = camOn; p.screen = sharing;
    updateTile(me.sid);
    layout();
  }

  function applyPerms() {
    if (!perms.mic && micOn) setMic(false, true);
    if (!perms.cam && camOn) setCam(false, true);
    if (!perms.screen && sharing) stopShare();
    var input = $('#chat-input');
    input.disabled = !perms.chat;
    $('#chat-off').hidden = perms.chat;
    $('#chat-form').hidden = !perms.chat;
    updateControls();
  }

  function updateControls() {
    var mic = $('#btn-mic'), cam = $('#btn-cam'), share = $('#btn-share');
    setCtl(mic, {
      on: micOn, locked: !perms.mic, icon: micOn ? 'mic' : 'mic-off',
      label: !perms.mic ? 'میکروفن بسته' : (micOn ? 'میکروفن' : 'میکروفن خاموش')
    });
    setCtl(cam, {
      on: camOn, locked: !perms.cam, icon: camOn ? 'cam' : 'cam-off',
      label: !perms.cam ? 'دوربین بسته' : (camOn ? 'دوربین' : 'دوربین خاموش')
    });
    share.hidden = !hasDisplay;
    setCtl(share, {
      on: sharing, neutral: true, locked: !perms.screen, active: sharing, icon: 'screen',
      label: sharing ? 'توقف اشتراک' : 'اشتراک صفحه'
    });
    $('#share-banner').hidden = !sharing;
  }

  /* ───────── اتصال WebRTC ───────── */
  function createPeer(sid, initiator) {
    var pc = new RTCPeerConnection(RTC_CONFIG);
    var e = { sid: sid, pc: pc, stream: new MediaStream(), aSender: null, vSender: null, pending: [], initiator: initiator, restarting: false, timer: null };
    peers.set(sid, e);

    pc.onicecandidate = function (ev) {
      if (ev.candidate && socket) socket.emit('signal', { to: sid, data: { candidate: ev.candidate.toJSON() } });
    };
    pc.ontrack = function (ev) {
      if (e.stream.getTracks().indexOf(ev.track) === -1) e.stream.addTrack(ev.track);
      attachStream(sid);
      ev.track.onunmute = function () { attachStream(sid); };
    };
    pc.onconnectionstatechange = function () {
      var s = pc.connectionState;
      clearTimeout(e.timer);
      if (s === 'failed' && e.initiator) restartIce(e);
      else if (s === 'disconnected' && e.initiator) {
        e.timer = setTimeout(function () { if (pc.connectionState === 'disconnected') restartIce(e); }, 5000);
      }
    };

    var queued = pendingCand.get(sid);
    if (queued) { e.pending = queued; pendingCand.delete(sid); }

    if (initiator) {
      var a = pc.addTransceiver(audioTrack || 'audio', { direction: 'sendrecv' });
      var v = pc.addTransceiver(currentVideoTrack() || 'video', { direction: 'sendrecv' });
      e.aSender = a.sender;
      e.vSender = v.sender;
    }
    return e;
  }

  function sendOffer(e, opts) {
    return e.pc.createOffer(opts).then(function (offer) {
      return e.pc.setLocalDescription(offer).then(function () {
        socket.emit('signal', { to: e.sid, data: { sdp: { type: offer.type, sdp: offer.sdp } } });
      });
    });
  }

  function restartIce(e) {
    if (e.restarting || !peers.has(e.sid)) return;
    e.restarting = true;
    sendOffer(e, { iceRestart: true }).catch(function () {});
    setTimeout(function () { e.restarting = false; }, 8000);
  }

  function flushCandidates(e) {
    var list = e.pending.splice(0);
    return Promise.all(list.map(function (c) { return e.pc.addIceCandidate(c).catch(function () {}); }));
  }

  function onSignal(msg) {
    var from = msg.from, data = msg.data, e = peers.get(from);
    if (!data) return Promise.resolve();

    if (data.sdp && data.sdp.type === 'offer') {
      if (!e) e = createPeer(from, false);
      var jobs = [];
      return e.pc.setRemoteDescription(data.sdp).then(function () {
        e.pc.getTransceivers().forEach(function (t) {
          var kind = t.receiver && t.receiver.track && t.receiver.track.kind;
          if (kind === 'audio') {
            t.direction = 'sendrecv'; e.aSender = t.sender;
            jobs.push(t.sender.replaceTrack(audioTrack || null).catch(function () {}));
          } else if (kind === 'video') {
            t.direction = 'sendrecv'; e.vSender = t.sender;
            jobs.push(t.sender.replaceTrack(currentVideoTrack() || null).catch(function () {}));
          }
        });
        return Promise.all(jobs);
      }).then(function () {
        return flushCandidates(e);
      }).then(function () {
        return e.pc.createAnswer();
      }).then(function (ans) {
        return e.pc.setLocalDescription(ans).then(function () {
          socket.emit('signal', { to: from, data: { sdp: { type: ans.type, sdp: ans.sdp } } });
        });
      }).catch(function (err) { console.warn('offer error', err); });
    }

    if (data.sdp && data.sdp.type === 'answer') {
      if (!e) return Promise.resolve();
      return e.pc.setRemoteDescription(data.sdp).then(function () { return flushCandidates(e); })
        .catch(function (err) { console.warn('answer error', err); });
    }

    if (data.candidate) {
      if (e && e.pc.remoteDescription) {
        return e.pc.addIceCandidate(data.candidate).catch(function () {});
      }
      if (e) e.pending.push(data.candidate);
      else {
        var q = pendingCand.get(from) || [];
        q.push(data.candidate);
        pendingCand.set(from, q);
      }
    }
    return Promise.resolve();
  }

  function attachStream(sid) {
    var t = tiles.get(sid), e = peers.get(sid);
    if (!t || !e) return;
    if (t.video.srcObject !== e.stream) t.video.srcObject = e.stream;
    var p = t.video.play();
    if (p && p.catch) p.catch(function () {});
  }

  function closePeer(sid) {
    var e = peers.get(sid);
    if (e) { clearTimeout(e.timer); try { e.pc.close(); } catch (x) { /* ignore */ } }
    peers.delete(sid);
    pendingCand.delete(sid);
  }

  function closeAllPeers() {
    Array.from(peers.keys()).forEach(closePeer);
  }

  /* ───────── کاشی‌های تصویر ───────── */
  var grid = $('#grid');

  function initial(name) { return (name || '؟').trim().charAt(0) || '؟'; }

  function ensureTile(p) {
    var t = tiles.get(p.sid);
    if (t) return t;
    var isMe = !!(me && p.sid === me.sid);
    var video = h('video', { autoplay: true, playsinline: true });
    video.muted = isMe;
    var avatarLetter = h('span', null, initial(p.name));
    var nameEl = h('span', { class: 'tname' });
    var flag = h('span', { class: 'mic-flag', title: 'میکروفن خاموش است' }, icon('mic-off'));
    var badge = h('span', { class: 'share-flag', title: 'در حال اشتراک صفحه' }, icon('screen'));
    var el = h('div', { class: 'tile' + (isMe ? ' local' : ''), 'data-sid': p.sid },
      video,
      h('div', { class: 'avatar' }, avatarLetter),
      h('div', { class: 'label' }, nameEl, badge, flag)
    );
    el.addEventListener('dblclick', function () {
      if (el.requestFullscreen) el.requestFullscreen().catch(function () {});
    });
    grid.appendChild(el);
    t = { el: el, video: video, nameEl: nameEl, avatarLetter: avatarLetter, isMe: isMe };
    tiles.set(p.sid, t);
    if (isMe) updateLocalPreview(); else attachStream(p.sid);
    return t;
  }

  function updateLocalPreview() {
    if (!me) return;
    var t = tiles.get(me.sid);
    if (!t) return;
    var track = currentVideoTrack();
    t.video.srcObject = new MediaStream(track ? [track] : []);
    var pl = t.video.play();
    if (pl && pl.catch) pl.catch(function () {});
  }

  function presenterSid() {
    var best = null;
    info.forEach(function (p) {
      if (!p.screen) return;
      if (!best || (p.role === 'teacher' && best.role !== 'teacher')) best = p;
    });
    return best ? best.sid : null;
  }

  function updateTile(sid) {
    var p = info.get(sid), t = tiles.get(sid);
    if (!p || !t) return;
    var isMe = me && sid === me.sid;
    t.nameEl.textContent = p.name + (p.role === 'teacher' ? ' (معلم)' : '') + (isMe ? ' (شما)' : '');
    t.avatarLetter.textContent = initial(p.name);
    t.el.classList.toggle('no-video', !(p.cam || p.screen));
    t.el.classList.toggle('is-screen', !!p.screen);
    t.el.classList.toggle('is-muted', !p.mic);
    t.el.classList.toggle('is-teacher', p.role === 'teacher');
    t.el.classList.toggle('is-sharing', !!p.screen);
  }

  function layout() {
    var ps = presenterSid(), order = 0;
    grid.classList.toggle('has-presenter', !!ps);
    grid.dataset.n = String(tiles.size);
    info.forEach(function (p, sid) {
      var t = tiles.get(sid);
      if (!t) return;
      t.el.style.order = String(order++);
      t.el.classList.toggle('presenting', sid === ps);
    });
  }

  function removePeer(sid) {
    closePeer(sid);
    var t = tiles.get(sid);
    if (t) { t.video.srcObject = null; t.el.remove(); tiles.delete(sid); }
    info.delete(sid);
  }

  function onRoster(list) {
    if (!me) return;
    var seen = new Set();
    list.forEach(function (p) {
      seen.add(p.sid);
      var mine = p.sid === me.sid;
      if (mine) { p.mic = micOn; p.cam = camOn; p.screen = sharing; }  // وضعیت محلی دقیق‌تر است
      info.set(p.sid, p);
      ensureTile(p);
      updateTile(p.sid);
    });
    Array.from(info.keys()).forEach(function (sid) { if (!seen.has(sid)) removePeer(sid); });
    // ترتیب در roster ملاک است
    var ordered = new Map();
    list.forEach(function (p) { ordered.set(p.sid, info.get(p.sid)); });
    info.clear();
    ordered.forEach(function (v, k) { info.set(k, v); });
    layout();
    $('#people-count').textContent = String(list.length);
    if (!IS_TEACHER) renderStudentPeople();
  }

  /* ───────── گفتگو ───────── */
  var chatLog = $('#chat-log');

  function nearBottom() { return chatLog.scrollHeight - chatLog.scrollTop - chatLog.clientHeight < 80; }

  function addMsg(m, quiet) {
    var stick = nearBottom();
    var mine = me && m.sid === me.sid;
    chatLog.appendChild(h('div', { class: 'msg' + (mine ? ' mine' : '') + (m.role === 'teacher' ? ' teacher' : '') },
      h('div', { class: 'msg-meta' },
        h('b', null, m.name),
        m.role === 'teacher' ? h('span', { class: 'chip sm' }, 'معلم') : null,
        h('time', null, RN.fmtTime(m.ts))
      ),
      h('div', { class: 'msg-text' }, m.text)
    ));
    if (stick || mine) chatLog.scrollTop = chatLog.scrollHeight;
    if (!quiet && !mine && !chatVisible()) { unread++; renderBadge(); }
  }

  function renderBadge() {
    ['chat-badge', 'dock-badge'].forEach(function (id) {
      var b = $('#' + id);
      b.textContent = String(unread > 99 ? '99+' : unread);
      b.hidden = unread === 0;
    });
  }

  $('#chat-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var input = $('#chat-input'), text = input.value.trim();
    if (!text || !socket) return;
    socket.emit('chat', { text: text });
    input.value = '';
  });

  /* ───────── پنل کناری ───────── */
  function isNarrow() { return window.matchMedia('(max-width: 900px)').matches; }
  function sideOpen() { return document.body.classList.contains('side-open'); }
  function chatVisible() { return sideOpen() && activeTab === 'chat'; }

  function showTab(name) {
    activeTab = name;
    document.querySelectorAll('.stab').forEach(function (b) { b.classList.toggle('is-active', b.dataset.tab === name); });
    document.querySelectorAll('.pane').forEach(function (p) { p.hidden = p.id !== 'pane-' + name; });
    if (name === 'chat' && sideOpen()) { unread = 0; renderBadge(); chatLog.scrollTop = chatLog.scrollHeight; }
  }

  function setSide(open) {
    document.body.classList.toggle('side-open', open);
    $('#btn-side').classList.toggle('active', open);
    if (open && activeTab === 'chat') { unread = 0; renderBadge(); }
  }

  document.querySelectorAll('.stab').forEach(function (b) {
    b.addEventListener('click', function () { showTab(b.dataset.tab); });
  });
  $('#btn-side').addEventListener('click', function () { setSide(!sideOpen()); });
  $('#side-close').addEventListener('click', function () { setSide(false); });

  /* ───────── فهرست حاضرین / غایبین ───────── */
  function stateIcons(p) {
    return h('span', { class: 'pstat' },
      h('span', { class: p.mic ? 'ok' : 'off', title: p.mic ? 'میکروفن روشن' : 'میکروفن خاموش' }, icon(p.mic ? 'mic' : 'mic-off')),
      h('span', { class: p.cam ? 'ok' : 'off', title: p.cam ? 'دوربین روشن' : 'دوربین خاموش' }, icon(p.cam ? 'cam' : 'cam-off')),
      p.screen ? h('span', { class: 'ok', title: 'در حال اشتراک صفحه' }, icon('screen')) : null
    );
  }

  function renderStudentPeople() {
    var box = $('#people-list');
    box.replaceChildren();
    var n = 0;
    info.forEach(function (p, sid) {
      n++;
      box.appendChild(h('div', { class: 'prow' },
        h('span', { class: 'pname' }, p.name + (sid === (me && me.sid) ? ' (شما)' : ''),
          p.role === 'teacher' ? h('span', { class: 'chip sm' }, 'معلم') : null),
        stateIcons(p)
      ));
    });
    $('#present-count').textContent = String(n);
  }

  function confirmKick(u) {
    return RN.askDialog({
      title: 'اخراج ' + u.name,
      text: 'این دانش‌آموز از کلاس بیرون می‌شود و تا ' + cfg.kickMinutes + ' دقیقه نمی‌تواند دوباره وارد شود.',
      ok: 'اخراج', danger: true
    });
  }

  function permButton(u, key) {
    var on = u.perms[key];
    var icons = { mic: on ? 'mic' : 'mic-off', cam: on ? 'cam' : 'cam-off', chat: on ? 'chat' : 'chat-off', screen: 'screen' };
    return h('button', {
      type: 'button', class: 'tog ' + (on ? 'is-on' : 'is-off'),
      title: (on ? 'بستن ' : 'باز کردن ') + PERM_LABELS[key] + ' برای ' + u.name,
      'aria-pressed': on ? 'true' : 'false',
      onclick: function () { socket.emit('ctl_user', { room: cfg.room, user_id: u.user_id, key: key, value: !on }); }
    }, icon(icons[key]));
  }

  function renderTeacherPeople() {
    if (!roomState) return;
    var box = $('#people-list'), abox = $('#absent-list');
    box.replaceChildren();
    abox.replaceChildren();

    roomState.present.forEach(function (p) {
      var isStudent = p.role === 'student';
      box.appendChild(h('div', { class: 'prow' + (isStudent ? '' : ' is-teacher') },
        h('span', { class: 'pname' }, p.name + (me && p.sid === me.sid ? ' (شما)' : ''),
          p.role === 'teacher' ? h('span', { class: 'chip sm' }, 'معلم') : null),
        stateIcons(p),
        isStudent ? h('span', { class: 'pacts' },
          ['mic', 'cam', 'chat', 'screen'].map(function (k) { return permButton(p, k); }),
          h('button', {
            type: 'button', class: 'tog kick', title: 'اخراج ' + p.name,
            onclick: function () {
              confirmKick(p).then(function (r) { if (r !== null) socket.emit('ctl_kick', { room: cfg.room, user_id: p.user_id }); });
            }
          }, icon('ban'))
        ) : null
      ));
    });
    if (!roomState.present.length) box.appendChild(h('p', { class: 'empty' }, 'هنوز کسی در کلاس نیست.'));

    roomState.absent.forEach(function (u) {
      var banned = u.banned_until && u.banned_until * 1000 > Date.now();
      abox.appendChild(h('div', { class: 'prow absent' },
        h('span', { class: 'pname' }, u.name),
        banned ? h('span', { class: 'chip sm danger' }, 'اخراج تا ' + RN.fmtTime(u.banned_until)) : null,
        banned ? h('button', {
          type: 'button', class: 'btn small ghost',
          onclick: function () { socket.emit('ctl_unban', { room: cfg.room, user_id: u.user_id }); }
        }, 'رفع اخراج') : null
      ));
    });
    if (!roomState.absent.length) {
      abox.appendChild(h('p', { class: 'empty' }, roomState.registered ? 'همهٔ کاربران ثبت‌شده حاضرند.' : 'هنوز کاربری برای این کلاس ثبت نشده است. از پنل مدیریت اضافه کنید.'));
    }
    $('#present-count').textContent = String(roomState.present.length);
    $('#absent-count').textContent = String(roomState.absent.length);
  }

  function renderSwitches() {
    if (!roomState) return;
    var box = $('#ctl-switches');
    box.replaceChildren();
    ['mic', 'cam', 'chat', 'screen'].forEach(function (k) {
      var on = !!roomState.settings[k];
      box.appendChild(h('div', { class: 'sw-row' },
        h('span', null, SWITCH_LABELS[k]),
        h('button', {
          type: 'button', class: 'switch', role: 'switch', 'aria-checked': on ? 'true' : 'false',
          'aria-label': SWITCH_LABELS[k],
          onclick: function () { socket.emit('ctl_setting', { room: cfg.room, key: k, value: !on }); }
        })
      ));
    });
  }

  if (IS_TEACHER) {
    $('#mute-all').addEventListener('click', function () { socket.emit('ctl_setting', { room: cfg.room, key: 'mic', value: false }); toast('میکروفن همهٔ دانش‌آموزان بسته شد.'); });
    $('#unmute-all').addEventListener('click', function () { socket.emit('ctl_setting', { room: cfg.room, key: 'mic', value: true }); toast('میکروفن دانش‌آموزان باز شد.'); });
    $('#clear-chat').addEventListener('click', function () {
      RN.askDialog({ title: 'پاک کردن گفتگو', text: 'همهٔ پیام‌های این کلاس برای همه پاک می‌شود.', ok: 'پاک کن', danger: true })
        .then(function (r) { if (r !== null) socket.emit('ctl_clear_chat', { room: cfg.room }); });
    });
  }

  /* ───────── اتصال Socket.IO ───────── */
  function setConn(state, text) {
    var c = $('#conn');
    c.className = 'conn ' + state;
    c.querySelector('span').textContent = text;
  }

  function connect() {
    socket = io({ transports: ['websocket', 'polling'], reconnectionDelayMax: 5000 });

    socket.on('connect', function () {
      me = null;
      setConn('ok', 'متصل');
      socket.emit('join', { room: cfg.room, name: joinName });
    });

    socket.on('disconnect', function () {
      setConn('bad', 'اتصال قطع شد…');
      closeAllPeers();
      Array.from(info.keys()).forEach(removePeer);
      me = null;
    });

    socket.on('connect_error', function () { setConn('bad', 'مشکل در اتصال'); });

    socket.on('joined', function (d) {
      var first = !document.body.dataset.ready;
      me = { sid: d.sid, role: d.role, name: d.name };
      perms = d.perms;
      closeAllPeers();
      $('#prejoin').hidden = true;
      $('#app').hidden = false;
      $('#role-chip').textContent = IS_TEACHER ? 'معلم' : 'دانش‌آموز';
      $('#role-chip').classList.toggle('teacher', IS_TEACHER);
      if (first) {
        document.body.dataset.ready = '1';
        setSide(!isNarrow());
        showTab('chat');
      }
      chatLog.replaceChildren();
      d.chat.forEach(function (m) { addMsg(m, true); });
      applyPerms();

      // بار اول طبق انتخاب پیش از ورود؛ پس از اتصال مجدد طبق وضعیت فعلی
      var m0 = first ? wantMic : micOn, c0 = first ? wantCam : camOn;
      setMic(m0, true)
        .then(function () { return setCam(c0, true); })
        .then(function () {
          if (sharing) socket.emit('screen_state', { on: true });
          d.peers.forEach(function (p) {
            info.set(p.sid, p);
            ensureTile(p);
            updateTile(p.sid);
            var e = createPeer(p.sid, true);
            sendOffer(e).catch(function (err) { console.warn('offer error', err); });
          });
          layout();
        });
    });

    socket.on('roster', function (d) { onRoster(d.peers); });
    socket.on('room_state', function (st) { roomState = st; renderTeacherPeople(); renderSwitches(); });
    socket.on('signal', function (m) { onSignal(m); });
    socket.on('chat', function (m) { addMsg(m, false); });
    socket.on('chat_cleared', function () { chatLog.replaceChildren(); toast('گفتگو پاک شد.'); });
    socket.on('toast', function (m) { toast(m.msg, 'warn'); });

    socket.on('perms', function (p) {
      var old = perms;
      perms = p;
      applyPerms();
      if (!IS_TEACHER) {
        Object.keys(PERM_LABELS).forEach(function (k) {
          if (old[k] && !p[k]) toast('معلم ' + PERM_LABELS[k] + ' را بست.', 'warn');
          else if (!old[k] && p[k]) toast(PERM_LABELS[k] + ' برای شما باز شد.', 'ok');
        });
      }
    });

    socket.on('kicked', function (d) {
      if (d.removed) end('حساب شما حذف شد', 'حساب شما از این کلاس حذف شده است. با مدیر تماس بگیرید.');
      else end('از کلاس اخراج شدید', 'تا ' + d.minutes + ' دقیقهٔ دیگر نمی‌توانید به این کلاس برگردید.');
    });
    socket.on('replaced', function () {
      end('ورود از جای دیگر', 'این حساب در یک دستگاه یا زبانهٔ دیگر وارد کلاس شد و این اتصال بسته شد.');
    });
    socket.on('fatal', function (d) { end('ورود ممکن نیست', d.msg, d.redirect); });
  }

  /* ───────── پایان ───────── */
  function stopEverything() {
    finished = true;
    stopShare();
    closeAllPeers();
    [audioTrack, videoTrack].forEach(function (t) { if (t) t.stop(); });
    audioTrack = videoTrack = null;
    if (socket) { socket.io.reconnection(false); socket.disconnect(); }
  }

  function end(title, text, link) {
    stopEverything();
    $('#overlay-title').textContent = title;
    $('#overlay-text').textContent = text;
    $('#overlay-link').setAttribute('href', link || (IS_TEACHER ? '/admin' : '/'));
    $('#overlay').hidden = false;
    document.querySelector('.layout') && (document.querySelector('.layout').style.visibility = 'hidden');
  }

  function leave() {
    RN.askDialog({ title: 'خروج از کلاس', text: 'می‌خواهید از کلاس خارج شوید؟', ok: 'خروج', danger: true }).then(function (r) {
      if (r === null) return;
      stopEverything();
      var go = function () { location.href = IS_TEACHER ? '/admin' : '/'; };
      if (IS_TEACHER) go(); else RN.api('/api/student/logout', 'POST').then(go, go);
    });
  }

  /* ───────── دکمه‌های پایین ───────── */
  $('#btn-mic').addEventListener('click', function () {
    if (!perms.mic) { toast('معلم میکروفن را بسته است.', 'warn'); return; }
    setMic(!micOn);
  });
  $('#btn-cam').addEventListener('click', function () {
    if (!perms.cam) { toast('معلم دوربین را بسته است.', 'warn'); return; }
    setCam(!camOn);
  });
  $('#btn-share').addEventListener('click', function () { if (sharing) stopShare(); else startShare(); });
  $('#share-stop').addEventListener('click', stopShare);
  $('#btn-leave').addEventListener('click', leave);

  window.addEventListener('pagehide', function () { if (!finished) { [audioTrack, videoTrack].forEach(function (t) { if (t) t.stop(); }); } });
})();
