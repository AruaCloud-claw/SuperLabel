/* 切片审查页：按标注框裁剪切片，按标签分类浏览，支持跳转修正 */
const tid = new URLSearchParams(location.search).get('id');
const tname = new URLSearchParams(location.search).get('name') || '';
let classes = [];          // [{name,color}]
let page = 1, pages = 1, curCls = null;   // curCls=null=全部
let polling = null;

function onPageReady() {
  $('tname').textContent = tname ? `· ${tname}` : '';
  loadClasses().then(checkExisting);
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

/* ===== 开始切片 + 进度轮询 ===== */
function showBar(pct) {
  $('genbar').style.display = pct == null ? 'none' : 'block';
  if (pct != null) $('genbarfill').style.width = pct + '%';
}

async function startGen() {
  $('genbtn').disabled = true;
  $('cmsg').textContent = '切片任务已启动…';
  showBar(0);
  let r, res;
  try {
    r = await api(`/api/anno_tasks/${tid}/crops/generate`, { method: 'POST' });
    res = await r.json();
  } catch (e) {
    $('cmsg').textContent = r && r.status === 404
      ? '后端无切片接口（服务版本过旧，请重启 SuperLabel 服务）'
      : '切片请求失败: ' + (e && e.message ? e.message : e);
    $('genbtn').disabled = false; showBar(null); return;
  }
  if (!res.ok) { $('cmsg').textContent = res.err || '启动失败'; $('genbtn').disabled = false; showBar(null); return; }
  pollStatus();
}

async function pollStatus() {
  if (polling) clearInterval(polling);
  polling = setInterval(async () => {
    let res;
    try {
      const r = await api(`/api/anno_tasks/${tid}/crops/status`);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      res = await r.json();
    } catch (e) {
      clearInterval(polling); polling = null;
      $('cmsg').textContent = '进度查询失败: ' + (e && e.message ? e.message : e) + '（请刷新重试）';
      $('genbtn').disabled = false; showBar(null);
      return;
    }
    if (res.running) {
      const pct = res.total ? Math.round(res.done / res.total * 100) : 0;
      showBar(pct);
      $('cmsg').textContent = `切片中… ${res.done}/${res.total} 帧（${pct}%）`;
    } else if (res.ready) {
      clearInterval(polling); polling = null;
      showBar(null);
      $('genbtn').disabled = false; $('genbtn').textContent = '重新切片';
      $('cmsg').textContent = '切片完成 ✓ 可按标签分类浏览；发现标注错误点「去修正」跳回标注页修改';
      curCls = null; page = 1;
      await loadClasses(); renderTabs(); loadList();
    }
  }, 1200);
}

async function checkExisting() {   // 已有切片则直接展示；进行中则恢复进度条
  const res = await (await api(`/api/anno_tasks/${tid}/crops/status`)).json();
  if (res.running) {
    $('genbtn').disabled = true;
    $('cmsg').textContent = '切片任务进行中…';
    pollStatus();
    return;
  }
  if (res.ready) {
    $('genbtn').textContent = '重新切片';
    $('cmsg').textContent = '已有切片结果，可直接浏览；点「重新切片」按最新标注重新生成';
    await loadClasses(); renderTabs(); loadList();
  }
}

/* ===== 分类 tab + 列表 ===== */
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
  const res = await (await api(`/api/anno_tasks/${tid}/crops?page=${page}${clsq}`)).json();
  pages = res.pages; page = res.page;
  $('pinfo').textContent = `共 ${res.total} 个切片 · 第 ${page}/${Math.max(1, pages)} 页`;
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
     </div></div>`;
  }).join('') : '<div style="color:#666">无切片（该类别下没有标注框）</div>';
}

function gotoPage(p) { if (p >= 1 && p <= pages) { page = p; loadList(); } }

function gotoEdit(gi, bi) {
  location.href = `/ui/task_detail.html?id=${tid}&gi=${gi}&box=${bi}`;
}
