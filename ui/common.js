/* 共享：API 助手 + 登录守卫 + 导航栏渲染 */
const $ = id => document.getElementById(id);
const T = localStorage.getItem('token');
const H = { Authorization: 'Bearer ' + T };

async function api(p, opt) {
  const r = await fetch(p, Object.assign({ headers: Object.assign({ Accept: 'application/json' }, H,
    opt && opt.body ? { 'Content-Type': 'application/json' } : {}) }, opt));
  if (r.status === 401) { localStorage.clear(); location.href = '/'; throw 0; }
  return r;
}
function fmtSize(n) { return n > 1e9 ? (n / 1e9).toFixed(2) + ' GB'
  : n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : (n / 1e3).toFixed(0) + ' KB'; }
function fmtDur(s) { if (!s) return '-';
  s = Math.round(s); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }

/* 登录守卫 + 导航注入。页面 <body> 内需含 <div id="nav"></div> 和 <div id="layout"> */
async function authGuard() {
  if (!T) { location.href = '/'; throw 'no token'; }
  try {
    const me = await (await api('/api/me')).json();
    window.ME = me;
    renderNav(me);
    const who = document.getElementById('who');
    if (who) who.innerHTML = `<span>${me.display_name || me.username} (${me.role})</span>`;
    if (typeof onPageReady === 'function') onPageReady(me);
  } catch (e) { if (e !== 'no token') location.href = '/'; }
}

const NAV_ITEMS = [
  { id: 'overview', name: '总览', href: '/ui/overview.html', icon:
    '<rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/>' },
  { id: 'videos', name: '原始视频管理', href: '/ui/videos.html', icon:
    '<path d="M21 8V21H3V8"/><rect x="1" y="3" width="22" height="5" rx="1"/><path d="M10 12h4"/>' },
  { id: 'tasks', name: '任务广场', href: '/ui/tasks.html', icon:
    '<path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/>' },
  { id: 'gallery', name: '数据集广场', href: '/ui/gallery.html', icon:
    '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/>\
<rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>' },
  { id: 'admin', name: '后台管理', href: '/ui/admin.html', adminOnly: true, icon:
    '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z"/>' },
];

function renderNav(me) {
  const nav = document.getElementById('nav');
  if (!nav) return;
  const cur = location.pathname;
  let html = `<div id="navhead" onclick="document.getElementById('nav').classList.toggle('collapsed')">
   <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#9cf" stroke-width="2">
    <rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/></svg>
   <span>标注平台</span></div>`;
  for (const it of NAV_ITEMS) {
    if (it.adminOnly && me.role !== 'admin') continue;
    const active = cur.includes(it.id) || (it.id === 'videos' && cur.includes('video_detail'));
    html += `<a class="nbtn ${active ? 'active' : ''}" href="${it.href}">
     <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="2">${it.icon}</svg><span>${it.name}</span></a>`;
  }
  html += `<div id="navbottom">
   <div class="nbtn userinfo"><span>${me.display_name || me.username} (${me.role})</span></div>
   <div class="nbtn" onclick="logout()">
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
     <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><path d="M16 17l5-5-5-5M21 12H9"/></svg>
    <span>退出登录</span></div></div>`;
  nav.innerHTML = html;
}
function logout() { fetch('/api/logout', { method: 'POST', headers: H })
  .finally(() => { localStorage.clear(); location.href = '/'; }); }

/* ===== 顶部浮窗消息：从顶部下滑浮现，点击关闭，5 秒自动关闭 ===== */
function toast(msg, type) {
  type = type || 'info';   // info | ok | err
  let box = document.getElementById('toastbox');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toastbox';
    document.body.appendChild(box);
  }
  const t = document.createElement('div');
  t.className = 'toast toast-' + type;
  t.innerHTML = '<span class="tmsg"></span><span class="tclose">✕</span>';
  t.querySelector('.tmsg').textContent = msg;
  box.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  const close = () => {
    if (!t.parentNode) return;
    t.classList.remove('show');
    setTimeout(() => t.remove(), 300);
  };
  t.querySelector('.tclose').onclick = close;
  t.onclick = e => { if (e.target.className !== 'tclose') close(); };
  setTimeout(close, 5000);
  // 最多同时显示 2 条：超出时立即关掉最旧的
  const toasts = box.querySelectorAll('.toast');
  for (let k = 0; k < toasts.length - 2; k++) {
    const old = toasts[k];
    old.classList.remove('show');
    setTimeout(() => old.remove(), 300);
  }
}
