/* 问题清单页：多选（点击/矩形框选）+ 右侧批量操作（改类别/删框） */
const tid = new URLSearchParams(location.search).get('id');
const tname = new URLSearchParams(location.search).get('name') || '';
let classes = [];          // [{name,color}]
let page = 1, pages = 1, curCls = null;   // curCls=null=全部
let pageItems = [];        // 当前页条目
const selSet = new Set();  // "gi_bi" -> {gi,bi,cls,file,img}

function onPageReady() {
  $('tname').textContent = tname ? `· ${tname}` : '';
  loadClasses().then(() => { renderClsPick(); renderTabs(); loadList(); });
  setupRubber();
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

function renderClsPick() {
  $('clsPick').innerHTML = classes.map((c, k) =>
    `<option value="${k}">${c.name}</option>`).join('');
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

/* ===== 列表 ===== */
async function loadList() {
  $('cropgrid').innerHTML = '<div style="color:#888">加载中…</div>';
  const clsq = curCls === null ? '' : '&cls=' + curCls;
  const res = await (await api(`/api/anno_tasks/${tid}/crops/issues?page=${page}${clsq}`)).json();
  pages = res.pages; page = res.page;
  pageItems = res.items;
  $('pinfo').textContent = `共 ${res.total} 个问题切片 · 第 ${page}/${Math.max(1, pages)} 页`;
  $('prev').disabled = page <= 1;
  $('next').disabled = page >= pages;
  const T = localStorage.getItem('token');
  $('cropgrid').innerHTML = '<div id="rubber"></div>' + (res.items.length ? res.items.map(m => {
    const c = clsMeta(m.cls), key = m.gi + '_' + m.bi;
    return `<div class="cropcard ${selSet.has(key) ? 'sel' : ''}" data-key="${key}"
      data-gi="${m.gi}" data-bi="${m.bi}" data-cls="${m.cls}"
      data-file="${encodeURIComponent(m.file)}" data-img="${encodeURIComponent(m.img)}"
      onclick="cardClick(event,this)">
     <span class="ck">☐</span>
     <img loading="lazy" src="/api/anno_tasks/${tid}/crops/img/${m.img}?token=${T}"
      onclick="event.stopPropagation();window.open(this.src)" alt=""
      title="点卡片选择；点图片看大图">
     <div class="info">
      <span class="tag" style="background:${c.color}">${c.name}</span><br>
      ${m.file}<br>
      <span style="color:#888">第 ${m.gi + 1} 帧 · 第 ${m.bi + 1} 框</span><br>
      <button style="margin-top:4px;width:100%;padding:3px;pointer-events:auto"
       onclick="event.stopPropagation();gotoEdit(${m.gi},${m.bi})">去修正</button>
     </div></div>`;
  }).join('') : '<div style="color:#666">清单为空——去切片审查页点「加入清单」收集问题切片</div>');
  renderSelList();
}

function gotoPage(p) { if (p >= 1 && p <= pages) { page = p; loadList(); } }

function gotoEdit(gi, bi) {
  location.href = `/ui/task_detail.html?id=${tid}&gi=${gi}&box=${bi}`;
}

/* ===== 选择体系 ===== */
function keyOf(el) { return el.dataset.gi + '_' + el.dataset.bi; }

function cardClick(e, card) {
  if (e.target.closest('button')) return;   // 卡内按钮（去修正）不走选择
  toggleSel(card);
}

function toggleSel(card) {
  const key = keyOf(card);
  const ck = card.querySelector('.ck');
  if (selSet.has(key)) {
    selSet.delete(key);
    card.classList.remove('sel');
    if (ck) ck.textContent = '☐';
  } else {
    selSet.set(key, { gi: +card.dataset.gi, bi: +card.dataset.bi,
      cls: +card.dataset.cls, file: decodeURIComponent(card.dataset.file),
      img: decodeURIComponent(card.dataset.img) });
    card.classList.add('sel');
    if (ck) ck.textContent = '✔';
  }
  renderSelList();
}

function selectAllOnPage() {
  document.querySelectorAll('#cropgrid .cropcard').forEach(card => {
    if (!selSet.has(keyOf(card))) toggleSel(card);
  });
}

function clearSel() {
  selSet.clear();
  document.querySelectorAll('#cropgrid .cropcard.sel').forEach(c => c.classList.remove('sel'));
  renderSelList();
}

function renderSelList() {
  $('seln').textContent = selSet.size;
  $('oplist').innerHTML = [...selSet.entries()].map(([key, m]) => {
    const c = clsMeta(m.cls);
    return `<div onclick="removeSel('${key}')">
     <span><span class="tag" style="background:${c.color}">${c.name}</span> ${m.file} #${m.bi + 1}</span>
     <span style="color:#f66">✕</span></div>`;
  }).join('') || '<div style="color:#666;cursor:default">（未选择）</div>';
}

function removeSel(key) {
  selSet.delete(key);
  const card = document.querySelector(`#cropgrid .cropcard[data-key="${key}"]`);
  if (card) card.classList.remove('sel');
  renderSelList();
}

/* 矩形框选：在网格空白处按下拖动画矩形，与卡片相交者追加选中 */
function setupRubber() {
  const grid = document.getElementById('cropgrid');
  const rubber = document.getElementById('rubber');
  let sx = 0, sy = 0, on = false;
  grid.addEventListener('mousedown', e => {
    if (e.button !== 0 || e.target.closest('.cropcard')) return;
    on = true;
    const gr = grid.getBoundingClientRect();
    sx = e.clientX - gr.left + grid.scrollLeft;
    sy = e.clientY - gr.top + grid.scrollTop;
    rubber.style.left = sx + 'px'; rubber.style.top = sy + 'px';
    rubber.style.width = rubber.style.height = '0px';
    rubber.style.display = 'block';
    e.preventDefault();
  });
  window.addEventListener('mousemove', e => {
    if (!on) return;
    const gr = grid.getBoundingClientRect();
    const x = e.clientX - gr.left + grid.scrollLeft;
    const y = e.clientY - gr.top + grid.scrollTop;
    rubber.style.left = Math.min(x, sx) + 'px';
    rubber.style.top = Math.min(y, sy) + 'px';
    rubber.style.width = Math.abs(x - sx) + 'px';
    rubber.style.height = Math.abs(y - sy) + 'px';
  });
  window.addEventListener('mouseup', e => {
    if (!on) return;
    on = false;
    rubber.style.display = 'none';
    const w = parseFloat(rubber.style.width), h = parseFloat(rubber.style.height);
    if (w < 5 || h < 5) return;          // 视为误触
    const r = { l: parseFloat(rubber.style.left), t: parseFloat(rubber.style.top),
                r: parseFloat(rubber.style.left) + w, b: parseFloat(rubber.style.top) + h };
    document.querySelectorAll('#cropgrid .cropcard').forEach(card => {
      const cr = card.getBoundingClientRect();
      const cg = grid.getBoundingClientRect();
      const cl = cr.left - cg.left + grid.scrollLeft, ct = cr.top - cg.top + grid.scrollTop;
      const intersect = !(cl > r.r || cl + cr.width < r.l || ct > r.b || ct + cr.height < r.t);
      if (intersect && !selSet.has(keyOf(card))) toggleSel(card);
    });
  });
}

/* ===== 批量操作 ===== */
async function batchClassify() {
  if (!selSet.size) { toast('请先选择切片', 'err'); return; }
  const cls = parseInt($('clsPick').value, 10);
  const c = clsMeta(cls);
  if (!confirm(`将选中的 ${selSet.size} 个标注框类别改为「${c.name}」？直接修改标签文件。`)) return;
  try {
    const r = await api(`/api/anno_tasks/${tid}/crops/issues/batch_classify`,
      { method: 'POST', body: JSON.stringify({ items: [...selSet.values()], cls }) });
    const res = await r.json();
    if (!res.ok) throw new Error(res.err || 'HTTP ' + r.status);
    toast(`已改类别 ${res.done} 个${res.miss ? `，${res.miss} 个失败` : ''}`, res.miss ? 'err' : 'ok');
    selSet.clear();
    loadList();
  } catch (e) { toast('批量改类别失败: ' + (e && e.message ? e.message : e), 'err'); }
}

async function batchDelete() {
  if (!selSet.size) { toast('请先选择切片', 'err'); return; }
  if (!confirm(`将删除选中的 ${selSet.size} 个标注框（从标签文件移除，并删除对应切片）？此操作不可逆！`)) return;
  try {
    const r = await api(`/api/anno_tasks/${tid}/crops/issues/batch_delete`,
      { method: 'POST', body: JSON.stringify({ items: [...selSet.values()] }) });
    const res = await r.json();
    if (!res.ok) throw new Error(res.err || 'HTTP ' + r.status);
    toast(`已删除标注框 ${res.done} 个${res.miss ? `，${res.miss} 个失败` : ''}`, res.miss ? 'err' : 'ok');
    selSet.clear();
    loadList();
  } catch (e) { toast('批量删除失败: ' + (e && e.message ? e.message : e), 'err'); }
}

/* ===== 单项移出 / 清空 ===== */
async function clearIssues() {
  if (!confirm('确定清空整个问题清单？此操作不可逆。')) return;
  try {
    const r = await api(`/api/anno_tasks/${tid}/crops/issues`,
      { method: 'DELETE', body: JSON.stringify({ clear: true }) });
    const res = await r.json();
    if (!res.ok) throw new Error(res.err || 'HTTP ' + r.status);
    selSet.clear();
    loadList();
    toast(`已清空（${res.removed} 项）`, 'ok');
  } catch (e) {
    toast('清空失败: ' + (e && e.message ? e.message : e), 'err');
  }
}
