/* 问题清单页：展示用户在切片审查页加入清单的问题切片，支持跳转修正/移出 */
const tid = new URLSearchParams(location.search).get('id');
const tname = new URLSearchParams(location.search).get('name') || '';
let classes = [];          // [{name,color}]
let page = 1, pages = 1, curCls = null;   // curCls=null=全部

function onPageReady() {
  $('tname').textContent = tname ? `· ${tname}` : '';
  loadClasses().then(() => { renderTabs(); loadList(); });
}

async function loadClasses() {
  try {
    const t = await (await api('/api/anno_tasks/' + tid)).json();
    classes = (t.classes_json ? JSON.parse(t.classes_json) : [])
      .map((c, i) => typeof c === 'string'
        ? { name: c, color: ['#f33','#3c6','#36c','#f93','#c3c','#0cc'][i % 6] } : c);
  } catch (e) { classes = []; }
}

function clsMeta(k) {
  return classes[k] || { name: '#' + k, color: '#888' };
}

function renderTabs() {
  $('tabs').innerHTML =
    `<button class="clstab ${curCls === null ? 'active' : ''}" onclick="pickCls(null)">全部</button>` +
    classes.map((c, k) =>
      `<button class="clstab ${curCls === k ? 'active' : ''}" onclick="pickCls(${k})">
       <span class="tag" style="background:${c.color}">${c.name}</span></button>`).join('');
}

async function pickCls(k) {
  curCls = k; page = 1;
  renderTabs(); loadList();
}

async function loadList() {
  $('cropgrid').innerHTML = '<div style="color:#888">加载中…</div>';
  const clsq = curCls === null ? '' : '&cls=' + curCls;
  const res = await (await api(`/api/anno_tasks/${tid}/crops/issues?page=${page}${clsq}`)).json();
  pages = res.pages; page = res.page;
  $('pinfo').textContent = `共 ${res.total} 个问题切片 · 第 ${page}/${Math.max(1, pages)} 页`;
  $('prev').disabled = page <= 1;
  $('next').disabled = page >= pages;
  const T = localStorage.getItem('token');
  $('cropgrid').innerHTML = res.items.length ? res.items.map(m => {
    const c = clsMeta(m.cls);
    return `<div class="cropcard">
     <img loading="lazy" src="/api/anno_tasks/${tid}/crops/img/${m.img}?token=${T}"
      onclick="window.open(this.src)" alt="">
     <div class="info">
      <span class="tag" style="background:${c.color}">${c.name}</span><br>
      ${m.file}<br>
      <span style="color:#888">第 ${m.gi + 1} 帧 · 第 ${m.bi + 1} 框</span><br>
      <button style="margin-top:4px;width:100%;padding:3px"
       onclick="gotoEdit(${m.gi},${m.bi})">去修正</button>
      <button style="margin-top:4px;width:100%;padding:3px"
       onclick="removeIssue(${m.gi},${m.bi},this)">移出清单</button>
     </div></div>`;
  }).join('') : '<div style="color:#666">清单为空——去切片审查页点「加入清单」收集问题切片</div>';
}

function gotoPage(p) { if (p >= 1 && p <= pages) { page = p; loadList(); } }

function gotoEdit(gi, bi) {
  location.href = `/ui/task_detail.html?id=${tid}&gi=${gi}&box=${bi}`;
}

async function removeIssue(gi, bi, btn) {
  try {
    const r = await api(`/api/anno_tasks/${tid}/crops/issues`,
      { method: 'DELETE', body: JSON.stringify({ gi, bi }) });
    const res = await r.json();
    if (!res.ok) throw new Error(res.err || 'HTTP ' + r.status);
    btn.closest('.cropcard').remove();
    loadList();
    toast('已移出清单', 'ok');
  } catch (e) {
    toast('移出失败: ' + (e && e.message ? e.message : e), 'err');
  }
}

async function clearIssues() {
  if (!confirm('确定清空整个问题清单？此操作不可逆。')) return;
  try {
    const r = await api(`/api/anno_tasks/${tid}/crops/issues`,
      { method: 'DELETE', body: JSON.stringify({ clear: true }) });
    const res = await r.json();
    if (!res.ok) throw new Error(res.err || 'HTTP ' + r.status);
    loadList();
    toast(`已清空（${res.removed} 项）`, 'ok');
  } catch (e) {
    toast('清空失败: ' + (e && e.message ? e.message : e), 'err');
  }
}
