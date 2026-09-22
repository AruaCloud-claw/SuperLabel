/* 任务详情页：视频竖列 / 帧显示区(可交互标注) / 任务编辑+操作+日志
   帧标注：框按标签颜色显示，可选中/拖动/缩放/新增/删除，S 保存 */
const tid = new URLSearchParams(location.search).get('id');
let curVideo = null, curDs = null, datasets = [], frameList = [];
let classes = [];                    // [{name,color}]
let dboxes = [], sel = -1;           // 当前帧框 [x1,y1,x2,y2,cls]
let hist = [], changed = false, drag = null, space = false;
let spaceStash = null;               // 临时移动期间挂起的绘制状态
let spaceDown = false, ctrlDown = false, spaceCancelled = false, ctrlCancelled = false;
// 临时移动：空格或 Ctrl “按一下松开”切换开/关；组合键期间不触发
function tempEnter(on) {
  if (space === on) return;
  space = on;
  if (space) {
    cv.style.cursor = 'grab'; syncToolBtns();
    if (pending || polyPts.length) {
      spaceStash = { pending, polyPts };
      pending = null; polyPts = []; hoverPt = null; drawBig();
    }
  } else {
    cv.style.cursor = tool === 'move' ? 'default' : 'crosshair'; syncToolBtns();
    if (spaceStash) {
      pending = spaceStash.pending; polyPts = spaceStash.polyPts; spaceStash = null;
      drawBig();
    }
  }
}
function tempToggle() { tempEnter(!space); }
const cv = document.getElementById('bigcv'), ctx = cv.getContext('2d');

function onPageReady() {
  if (localStorage.getItem('autoRv') === '1') $('autorv').checked = true;
  loadDetail();
  pollLogs().then(() => {   // 有进行中任务则恢复轮询（刷新后进度条不断）
    if (!pollTimer && window._hasRunning) pollTimer = setInterval(pollLogs, 1500);
  });
  window.addEventListener('keydown', kbd);
  window.addEventListener('keyup', e => {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
    if (e.code === 'Space') {
      if (spaceDown && !spaceCancelled) tempToggle();   // 按一下松开：切换
      spaceDown = false; spaceCancelled = false;
    }
    if (e.key === 'Control') {
      if (ctrlDown && !ctrlCancelled) tempToggle();
      ctrlDown = false; ctrlCancelled = false;
    }
  });
  window.addEventListener('resize', () => { if (cv.dataset.nw) drawBig(); });
  // 窗口失焦：复位按键按下标记（切换状态保留）
  window.addEventListener('blur', () => {
    spaceDown = ctrlDown = false; spaceCancelled = ctrlCancelled = false;
  });
  bindCanvas();
}

async function loadDetail() {
  try {
    const t = await (await api('/api/anno_tasks/' + tid)).json();
    $('tTitle').textContent = t.name;
    // 标签（兼容旧字符串数组）
    classes = (t.classes_json ? JSON.parse(t.classes_json) : [])
      .map((c, i) => typeof c === 'string'
        ? { name: c, color: ['#f33','#3c6','#36c','#f93','#c3c','#0cc'][i % 6] }
        : c);
    renderClsRows();
    $('tconf').value = t.conf != null ? t.conf : 0.05;
    if ($('vinfo')) $('vinfo').innerHTML = [
      ['状态', t.status], ['备注', t.note || '无'],
      ['创建人', t.creator || ''], ['创建时间', t.created_at]
    ].map(r => `<tr><th>${r[0]}</th><td>${r[1]}</td></tr>`).join('');
    datasets = await (await api('/api/datasets')).json();
    if (!t.videos.length) { $('vlist').textContent = '该任务未关联视频'; return; }
    window._taskVideoIds = new Set(t.videos.map(v => v.id));
    window._taskVideos = t.videos;
    renderLeft();
    // 池直显
    curDs = datasets.find(d => d.name === `task${tid}_pool`);
    if (curDs) {
      frameList = await fetchFrames();
      renderFrames();
    }
  } catch (err) {
    $('vlist').textContent = '加载失败: ' + err.message;
    console.error(err);
  }
}


function giOf(f, fallback) { return f && f.gi !== undefined ? f.gi : (f ? f.i : fallback); }
/* 帧列表加载（统一入口）：应用当前视频过滤器（window._videoFilter=null=全池） */
async function fetchFrames() {
  let url = `/api/ds/${curDs.id}/frames`;
  if (window._videoFilter)
    url += `?video_id=${window._videoFilter}&task_id=${tid}`;
  const items = await (await api(url)).json();
  items.forEach(it => { if (it.gi === undefined) it.gi = it.i; });   // 兼容旧后端
  return items;
}

/* ===== 标签编辑（一行一个 + 颜色） ===== */
function renderClsRows() {
  $('clsrows').innerHTML = classes.map((c, i) =>
    `<div style="display:flex;gap:6px;align-items:center;margin-bottom:4px;flex-wrap:nowrap">
     <span style="width:16px;flex:none;text-align:right;color:#888;font-size:12px">${i}</span>
     <input value="${c.name}" data-i="${i}" class="clsname" style="flex:1;min-width:0"
      placeholder="标签名（英文效果最佳）">
     <input type="color" value="${c.color}" data-i="${i}" class="clscolor"
      style="width:34px;min-width:34px;padding:0;height:26px;flex:none">
     <button class="warn" style="padding:2px 8px;flex:none" onclick="delCls(${i})">✕</button>
    </div>`).join('') +
    `<button class="ghost" style="padding:3px 10px" onclick="addCls()">＋ 添加标签</button>`;
}
function addCls() { collectCls(); classes.push({ name: '', color: uniqColor(classes.length) }); renderClsRows(); }
function delCls(i) { collectCls(); classes.splice(i, 1); renderClsRows(); }
function collectCls() {
  classes = [...document.querySelectorAll('#clsrows .clsname')].map((inp, i) => ({
    name: inp.value.trim(),
    color: document.querySelectorAll('#clsrows .clscolor')[i].value
  })).filter(c => c.name);
}
async function saveTaskCfg() {
  collectCls();
  if (!classes.length) { $('tcmsg').textContent = '至少一个标签'; return; }
  const conf = parseFloat($('tconf').value);
  const r = await api('/api/anno_tasks/' + tid, { method: 'PATCH',
    body: JSON.stringify({ classes, conf }) });
  const res = await r.json();
  $('tcmsg').textContent = r.ok ? '已保存 ✓' : (res.err || '保存失败');
  if (r.ok) { renderClsRows(); if (cv.dataset.nw) drawBig(); }
}

/* ===== 视频选择（跳帧） ===== */
function selVideo(id, name) {
  curVideo = { id, name };
  const tiles = document.querySelectorAll('.vtile');
  const tile = document.getElementById('tile' + id);
  if (window._videoFilter === id) {   // 再点一次：取消过滤，显示全池
    window._videoFilter = null;
    tile.classList.remove('sel');
    $('selinfo').textContent = '已选中: 全部视频';
    reloadFrames().then(() => toast('已显示全部视频的帧', 'info'));
    return;
  }
  tiles.forEach(t => t.classList.remove('sel'));
  tile.classList.add('sel');
  $('selinfo').textContent = '已选中: ' + name + '（再点一次显示全部）';
  window._videoFilter = id;
  reloadFrames().then(() => {
    const tv = (window._taskVideos || []).find(x => x.id === id);
    if (frameList.length) jumpToFrame(0);
    else toast('该视频尚未抽帧', 'info');
  });
}
/* 按当前过滤重新拉帧并刷新显示 */
async function reloadFrames() {
  frameList = await fetchFrames();
  renderFrames(true);
  return frameList;
}

/* ===== 帧列表（全池 + 懒加载 + 滚轮横滚） =====
   keep=true：保留当前选中帧与滚动位置（重建后回到当前帧并居中），
   仅首次加载/明确切换时才回第 0 帧 */
function renderFrames(keep) {
  if (!frameList.length) {
    $('bigframe').innerHTML = '<span style="color:#666">任务池暂无帧</span>';
    $('strip').innerHTML = '<span class="empty">帧列表为空</span>';
    return;
  }
  // 注意：bigframe 里除 canvas 外还有导航按钮，不能 innerHTML 清空
  cv.style.display = 'block';
  // 兼底：无论谁触发重建，都显式保存/恢复滚动位置（innerHTML 重建会原生归零）
  const _sl = $('strip').scrollLeft;
  $('strip').innerHTML = frameList.map((f, i) => {
    const bcolor = f.reviewed ? '#3c6' : (f.boxes > 0 ? '#fc3' : '#888');
    const btitle = f.reviewed ? '已人工复核' : (f.boxes > 0 ? '已自动标注' : '未标注');
    const g = giOf(f, i);   // 全局帧号（过滤视图下 ≠ 显示位置）
    return `<div class="thumb">
     <img loading="lazy" decoding="async" data-src="/api/ds/${curDs.id}/frame/${g}?token=${T}"
      onclick="showFrame(${i},this)" alt="">
     <span class="badge" style="background:${bcolor}" title="${btitle}"></span>
     <input type="checkbox" class="fselthumb" data-gi="${g}"
      title="勾选该帧（与任务图像列表联动）" ${window._selFrames.has(g) ? 'checked' : ''}
      onclick="event.stopPropagation()"
      onchange="_selAnchor=${g};toggleSelFrame(${g}, this.checked)">
     <button class="delbtn" title="删除该帧" onclick="askDeleteFrame(${i})">✕</button>
    </div>`;
  }).join('');
  $('strip').scrollLeft = _sl;   // 先恢复滚动，后续 showFrame 再居中校正
  const io = new IntersectionObserver(entries => {
    for (const e of entries) {
      if (e.isIntersecting) {
        if (e.target.dataset.src) { e.target.src = e.target.dataset.src; delete e.target.dataset.src; }
        io.unobserve(e.target);
      }
    }
  }, { root: $('strip'), rootMargin: '300px' });
  document.querySelectorAll('#strip .thumb img').forEach(img => io.observe(img));
  if (window._viewMode === 'image') renderLeft();   // 图像视图同步刷新
  const cur = keep && window._curFrame != null
    ? Math.min(window._curFrame, frameList.length - 1) : 0;
  const imgs = $('strip').querySelectorAll('.thumb img');
  if (imgs[cur]) {
    if (imgs[cur].dataset.src) { imgs[cur].src = imgs[cur].dataset.src; delete imgs[cur].dataset.src; }
    showFrame(cur, imgs[cur]);   // showFrame 内部会把选中帧滚动居中
  }
}
function jumpToFrame(i) {
  const imgs = document.querySelectorAll('#strip .thumb img');
  const el = imgs[i];
  if (el) {
    if (el.dataset.src) { el.src = el.dataset.src; delete el.dataset.src; }
    showFrame(i, el);
    el.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  }
}

/* ===== 大图绘制（图片 + 按标签着色的框） ===== */
async function showFrame(i, el) {
  // 切帧前：取消挂起的防抖定时器并同步保存；保存异常不阻塞翻帧（保留 changed 待重试）
  if (_autoT) { clearTimeout(_autoT); _autoT = null; }
  if (changed) {
    try {
      const ok = await saveFrame(true);
      if (!ok) toast('上一帧保存失败，修改已保留（Ctrl+S 重试）', 'err');
    } catch (err) {
      toast('保存请求异常，修改已保留（Ctrl+S 重试）', 'err');
      console.error('saveFrame error:', err);
    }
  }
  document.querySelectorAll('#strip .thumb img').forEach(x => x.classList.remove('sel'));
  if (el) {
    el.classList.add('sel');
    const sp = document.getElementById('strippos');
    if (sp) sp.textContent = `第${i + 1}张图片 共${frameList.length}个图片`;
    if (window._viewMode === 'image') highlightFrameItem(i);
    // 选中帧在列表中居中（不在可视区或贴边时滚动定位）
    // 注意：el.offsetLeft 相对 positioned 祖先（.thumb），不能用；用视口坐标差计算
    const strip = document.getElementById('strip');
    const sl = strip.scrollLeft, sw = strip.clientWidth;
    const l = el.getBoundingClientRect().left - strip.getBoundingClientRect().left + sl;
    const w = el.offsetWidth;
    if (l < sl || l + w > sl + sw)
      strip.scrollTo({ left: l - (sw - w) / 2, behavior: 'smooth' });
  }
  window._curFrame = i;
  // 查看即复核：自动标注帧查看后视为已复核
  const gi = giOf(frameList[i], i);   // 全局索引（过滤视图下 ≠ 显示位置）
  if (localStorage.getItem('autoRv') === '1' && frameList[i] &&
      frameList[i].boxes > 0 && !frameList[i].reviewed && curDs) {
    api(`/api/ds/${curDs.id}/review/${gi}`, { method: 'POST', body: '{}' })
      .then(rr => { if (rr.ok) { frameList[i].reviewed = 1;
        refreshThumbBadge(i); refreshFrameItem(i); } });
  }
  // 读该帧标注
  const r = await (await api(`/api/ds/${curDs.id}/label/${gi}`)).json();
  dboxes = (r.boxes || []).map(b => b.length > 4 ? [...b] : [...b, 0]);
  hist = []; sel = -1; changed = false;
  const img = new Image();
  img.onload = () => {
    cv.dataset.nw = img.naturalWidth; cv.dataset.nh = img.naturalHeight;
    window._bigImg = img;          // 缓存图片，后续同步重绘防闪烁
    drawBig();
  };
  img.src = `/api/ds/${curDs.id}/frame/${gi}?token=${T}`;
}
function drawBig() {
  const nw = +cv.dataset.nw, nh = +cv.dataset.nh;
  const img = window._bigImg;
  if (!nw || !img || !img.complete || !img.naturalWidth) return;  // 图未就绪不重绘（防闪烁）
  const wrap = $('bigframe');
  const z = Math.min((wrap.clientWidth - 8) / nw, (wrap.clientHeight - 8) / nh, 1);
  const w = Math.round(nw * z), h = Math.round(nh * z);
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  {
        ctx.drawImage(img, 0, 0, cv.width, cv.height);
    dboxes.forEach((b, i) => {
      const isSel = i === sel;
      if (b[0] === 'poly') {
        const cls = b[1], c = classes[cls] ? classes[cls].color : '#f33';
        ctx.beginPath();
        for (let k = 0; k < (b.length - 2) / 2; k++) {
          const px = b[2 + k * 2] * cv.width, py = b[3 + k * 2] * cv.height;
          if (k) ctx.lineTo(px, py); else ctx.moveTo(px, py);
        }
        ctx.closePath();
        ctx.fillStyle = c + '40';
        ctx.fill();
        ctx.strokeStyle = isSel ? '#ff0' : c;
        ctx.lineWidth = isSel ? 3 : 2;
        ctx.stroke();
        const label = classes[cls] ? classes[cls].name : '#' + cls;
        ctx.font = '12px sans-serif';
        const lx = b[2] * cv.width, ly = b[3] * cv.height;
        ctx.fillStyle = isSel ? '#ff0' : c;
        ctx.fillRect(lx, Math.max(0, ly - 16), ctx.measureText(label).width + 8, 16);
        ctx.fillStyle = '#111';
        ctx.fillText(label, lx + 4, Math.max(11, ly - 4));
        if (isSel) {
          ctx.fillStyle = '#ff0';
          for (let k = 0; k < (b.length - 2) / 2; k++)
            ctx.fillRect(b[2 + k * 2] * cv.width - 4, b[3 + k * 2] * cv.height - 4, 8, 8);
        }
      } else {
        const c = classes[b[4]] ? classes[b[4]].color : '#f33';
        const x = b[0] * cv.width, y = b[1] * cv.height,
              w = (b[2] - b[0]) * cv.width, h = (b[3] - b[1]) * cv.height;
        ctx.strokeStyle = isSel ? '#ff0' : c;
        ctx.lineWidth = isSel ? 3 : 2;
        ctx.strokeRect(x, y, w, h);
        const label = classes[b[4]] ? classes[b[4]].name : ('#' + b[4]);
        ctx.font = '12px sans-serif';
        ctx.fillStyle = isSel ? '#ff0' : c;
        ctx.fillRect(x, Math.max(0, y - 16), ctx.measureText(label).width + 8, 16);
        ctx.fillStyle = '#111';
        ctx.fillText(label, x + 4, Math.max(11, y - 4));
        if (isSel) {
          ctx.fillStyle = '#ff0';
          [[x, y], [x + w, y], [x, y + h], [x + w, y + h]]
            .forEach(p => ctx.fillRect(p[0] - 5, p[1] - 5, 10, 10));
          ctx.fillRect(x + w / 2 - 8, y - 3, 16, 6);
          ctx.fillRect(x + w / 2 - 8, y + h - 3, 16, 6);
          ctx.fillRect(x - 3, y + h / 2 - 8, 6, 16);
          ctx.fillRect(x + w - 3, y + h / 2 - 8, 6, 16);
        }
      }
    });
    // 多边形绘制预览
    if (polyPts.length && tool === 'poly') {
      ctx.strokeStyle = '#4cc'; ctx.lineWidth = 1.5;
      ctx.beginPath();
      polyPts.forEach((p, k) => {
        const px = p[0] * cv.width, py = p[1] * cv.height;
        if (k) ctx.lineTo(px, py); else ctx.moveTo(px, py);
      });
      if (hoverPt) ctx.lineTo(hoverPt[0] * cv.width, hoverPt[1] * cv.height);
      ctx.stroke();
      ctx.fillStyle = '#4cc';
      polyPts.forEach(p => ctx.fillRect(p[0] * cv.width - 4, p[1] * cv.height - 4, 8, 8));
    }
    // 新增框预览：起点标记 + 起终点矩形
    if (pending) {
      const px = pending[0] * cv.width, py = pending[1] * cv.height;
      ctx.strokeStyle = '#4cc'; ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(px - 9, py); ctx.lineTo(px + 9, py);
      ctx.moveTo(px, py - 9); ctx.lineTo(px, py + 9);
      ctx.stroke();
      if (hoverPt) {
        const hx = hoverPt[0] * cv.width, hy = hoverPt[1] * cv.height;
        ctx.setLineDash([6, 4]);
        ctx.strokeRect(Math.min(px, hx), Math.min(py, hy),
                       Math.abs(hx - px), Math.abs(hy - py));
        ctx.setLineDash([]);
      }
    }
  }
  renderAnnoDetail();
}

/* 标注详情列表：当前帧的标签与坐标 */
function renderAnnoDetail() {
  const el = document.getElementById('annodetail');
  if (!el) return;
  if (!dboxes.length) { el.innerHTML = '暂无标注'; return; }
  el.innerHTML = dboxes.map((b, i) => {
    const isPoly = b[0] === 'poly';
    const cls = isPoly ? b[1] : b[4];
    const name = classes[cls] ? classes[cls].name : '#' + cls;
    const color = classes[cls] ? classes[cls].color : '#f33';
    let coord;
    if (isPoly) {
      let x1 = 1, y1 = 1, x2 = 0, y2 = 0;
      for (let k = 0; k < (b.length - 2) / 2; k++) {
        x1 = Math.min(x1, b[2 + k * 2]); y1 = Math.min(y1, b[3 + k * 2]);
        x2 = Math.max(x2, b[2 + k * 2]); y2 = Math.max(y2, b[3 + k * 2]);
      }
      coord = `(${x1.toFixed(2)},${y1.toFixed(2)})-(${x2.toFixed(2)},${y2.toFixed(2)})`;
    } else {
      coord = `(${b[0].toFixed(2)},${b[1].toFixed(2)})-(${b[2].toFixed(2)},${b[3].toFixed(2)})`;
    }
    return `<div style="display:flex;gap:6px;align-items:center;padding:3px 0;
      border-bottom:1px solid #333;${i === sel ? 'background:#09477155' : ''}">
     <span style="width:8px;height:8px;background:${color};border-radius:2px"></span>
     <span class="annolabel" style="min-width:52px;cursor:text" title="双击改为其他标签（仅本图）"
      ondblclick="editAnnoLabel(event, ${i})">${name}${isPoly ? '(多边形)' : ''}</span>
     <span style="color:#888;font-family:monospace">${coord}</span>
    </div>`;
  }).join('');
}

/* 当前图片：双击标签名 → 下拉选新标签 → 仅改本图该框类别，自动保存 */
function editAnnoLabel(e, bi) {
  const el = e.target;
  const b = dboxes[bi];
  if (!b) return;
  const isPoly = b[0] === 'poly';
  const cls = isPoly ? b[1] : b[4];
  el.innerHTML = `<select style="width:100%;background:#333;color:#eee;
   border:1px solid #0e639c;border-radius:3px;font-size:12px">
   ${classes.map((c, k) => `<option value="${k}" ${k === cls ? 'selected' : ''}>${c.name}</option>`).join('')}
  </select>`;
  const selEl = el.querySelector('select');
  selEl.focus();
  let done = false;
  const apply = async () => {
    if (done) return; done = true;
    const to = +selEl.value;
    if (to === cls) { renderAnnoDetail(); return; }
    if (to === -1) {   // 删除该框
      pushHist();
      dboxes.splice(bi, 1); sel = -1;
      markChanged();
      drawBig(); renderAnnoDetail();
      toast('已删除该标注，自动保存中…', 'ok');
      return;
    }
    if (isPoly) b[1] = to; else b[4] = to;
    pushHist();
    markChanged();          // 防抖 600ms 自动保存
    drawBig(); renderAnnoDetail();
    toast(`已改为「${classes[to].name}」，自动保存中…`, 'ok');
  };
  selEl.onchange = apply;
  selEl.onblur = apply;
}

/* ===== 框交互：选中/拖动/缩放/新增(两点点击)/删除 ===== */
let pending = null;   // 新增框起点 [x,y]（归一化）
let tool = 'move';    // move | rect | poly
let polyPts = [];     // 多边形顶点
function syncToolBtns() {
  const eff = space ? 'move' : tool;   // 空格临时移动：按钮高亮跟随
  ['move', 'rect', 'poly'].forEach(x =>
    document.getElementById('tb-' + x).classList.toggle('active', x === eff));
}
function setTool(t) {
  tool = t; polyPts = []; pending = null; hoverPt = null; sel = -1;
  ['move', 'rect', 'poly'].forEach(x =>
    document.getElementById('tb-' + x).classList.toggle('active', x === t));
  cv.style.cursor = t === 'move' ? 'default' : 'crosshair';
  drawBig();
}
function cancelOp() {
  polyPts = []; pending = null; hoverPt = null; sel = -1;
  document.getElementById('clspop').style.display = 'none';
  drawBig();
}
let hoverPt = null;   // 预览终点

function toN(e) {
  const r = cv.getBoundingClientRect();
  return [(e.clientX - r.left) / cv.width, (e.clientY - r.top) / cv.height];
}
function bindCanvas() {
  cv.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    const r = cv.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
    const [x, y] = toN(e);

    // ===== 空格按住：临时移动模式（左键拖拽标注框） =====
    if (space) { moveModeHit(e, px, py, x, y); return; }

    // ===== 绘图模式：四边形 =====
    if (tool === 'rect') {
      if (!pending) { pending = [x, y]; drawBig(); return; }
      const cls = 0;
      const b = [Math.min(pending[0], x), Math.min(pending[1], y),
                 Math.max(pending[0], x), Math.max(pending[1], y), cls];
      if (b[2] - b[0] > 0.004 && b[3] - b[1] > 0.004) {
        sel = dboxes.length;
        pushHist();
        dboxes.push(b);
        markChanged();
        showClsPop(e.clientX, e.clientY);
      }
      pending = null; hoverPt = null;
      drawBig();
      return;
    }
    // ===== 绘图模式：多边形（点击加点；点起点或双击闭合） =====
    if (tool === 'poly') {
      if (polyPts.length >= 3) {
        const fx = polyPts[0][0] * cv.width, fy = polyPts[0][1] * cv.height;
        if (Math.hypot(px - fx, py - fy) < 10) { finishPoly(e); return; }
      }
      polyPts.push([x, y]);
      drawBig();
      return;
    }
    // ===== 移动模式：选择/拖动/缩放 =====
    moveModeHit(e, px, py, x, y);
  });
  window.addEventListener('mousemove', e => {
    if (!drag && (pending || (tool === 'poly' && polyPts.length))) {
      hoverPt = toN(e); drawBig(); return;
    }
    if (drag && drag.mode === 'polyv') {
      const cl = v => Math.min(1, Math.max(0, v));   // 顶点不得超出原图边界
      const [x, y] = toN(e), b = dboxes[drag.bi];
      b[2 + drag.vi * 2] = cl(x); b[3 + drag.vi * 2] = cl(y); drawBig(); return;
    }
    if (drag && drag.mode === 'polymove') {
      const cl = v => Math.min(1, Math.max(0, v));
      const [x, y] = toN(e), o = drag.orig, b = dboxes[sel];
      const dx = x - drag.sx, dy = y - drag.sy;
      if (b) for (let k = 0; k < (o.length - 2) / 2; k++) {
        b[2 + k * 2] = cl(o[2 + k * 2] + dx);
        b[3 + k * 2] = cl(o[3 + k * 2] + dy);
      }
      drawBig(); return;
    }
    if (!drag && !space && pending) { hoverPt = toN(e); drawBig(); return; }
    // 移动模式（或按住空格）：hover 边角时按方向切换双箭头光标
    if (!drag && (tool === 'move' || space)) {
      const r = cv.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
      let cur = 'default';
      for (let i = dboxes.length - 1; i >= 0; i--) {
        const b = dboxes[i];
        if (b[0] === 'poly') {
          let vi = -1;
          for (let k = 0; k < (b.length - 2) / 2; k++)
            if (Math.hypot(px - b[2 + k * 2] * cv.width,
                           py - b[3 + k * 2] * cv.height) < 9) { vi = k; break; }
          if (vi >= 0 && i === sel) { cur = 'move'; break; }
          if (pointInPoly(...toN(e), b)) { cur = 'move'; break; }
          continue;
        }
        const L = Math.min(b[0], b[2]) * cv.width, T = Math.min(b[1], b[3]) * cv.height,
              R = Math.max(b[0], b[2]) * cv.width, B = Math.max(b[1], b[3]) * cv.height;
        if (px < L - 10 || px > R + 10 || py < T - 10 || py > B + 10) continue;
        const nearL = Math.abs(px - L) < 10, nearR = Math.abs(px - R) < 10;
        const nearT = Math.abs(py - T) < 10, nearB = Math.abs(py - B) < 10;
        if (nearL && nearT || nearR && nearB) { cur = 'nwse-resize'; break; }
        if (nearR && nearT || nearL && nearB) { cur = 'nesw-resize'; break; }
        if (nearL || nearR) { cur = 'ew-resize'; break; }
        if (nearT || nearB) { cur = 'ns-resize'; break; }
        if (px > L && px < R && py > T && py < B) { cur = 'move'; break; }
      }
      cv.style.cursor = cur;
      return;
    }
    if (!drag) return;
    const cl = v => Math.min(1, Math.max(0, v));   // 边界/边角点不得超出原图
    const x = cl(toN(e)[0]), y = cl(toN(e)[1]);
    const b = dboxes[sel];
    if (!b) return;
    if (drag.mode === 'new') { b[2] = x; b[3] = y; }
    else if (drag.mode === 'move') {
      // 平移：整体钳位，框贴边停住不越界
      const dx = Math.min(1 - drag.orig[2], Math.max(-drag.orig[0], x - drag.sx));
      const dy = Math.min(1 - drag.orig[3], Math.max(-drag.orig[1], y - drag.sy));
      b[0] = drag.orig[0] + dx; b[1] = drag.orig[1] + dy;
      b[2] = drag.orig[2] + dx; b[3] = drag.orig[3] + dy;
    } else if (drag.mode === 'resize') {
      const g = drag.grip;
      if (g.includes('L')) b[0] = x;
      if (g.includes('R')) b[2] = x;
      if (g.includes('T')) b[1] = y;
      if (g.includes('B')) b[3] = y;
    }
    drawBig();
  });
  window.addEventListener('mouseup', () => {
    if (!drag) return;
    if (drag.mode === 'new' && sel >= 0) {
      const b = dboxes[sel];
      if (b[2] - b[0] < 0.004 || b[3] - b[1] < 0.004) { dboxes.splice(sel, 1); sel = -1; }
    }
    // 规范化：拖过对边导致反转的矩形，交换坐标
    if (sel >= 0 && dboxes[sel] && dboxes[sel][0] !== 'poly') {
      const b = dboxes[sel];
      if (b[0] > b[2]) { const t = b[0]; b[0] = b[2]; b[2] = t; }
      if (b[1] > b[3]) { const t = b[1]; b[1] = b[3]; b[3] = t; }
    }
    // 实际发生位移（与拖动前快照不同）才标脏；仅选中不标
    const b = sel >= 0 ? dboxes[sel] : null;
    const moved = b && drag.orig ? JSON.stringify(b) !== JSON.stringify(drag.orig)
      : (drag.mode === 'new' && sel >= 0);
    drag = null;
    if (moved) markChanged();
    else scheduleAutoSave();   // 无位移时不标脏，此调用自然 no-op
  });
}
function pushHist() {   // 纯快照：只记撤销历史，不标脏（避免“仅选中”也触发自动保存）
  hist.push(JSON.stringify(dboxes)); if (hist.length > 50) hist.shift();
}
function markChanged() { changed = true; scheduleAutoSave(); }
function delSel() { if (sel >= 0) { pushHist(); dboxes.splice(sel, 1); sel = -1; markChanged(); drawBig(); } }
function undo() { if (hist.length) { dboxes = JSON.parse(hist.pop()); sel = -1; drawBig(); } }
async function saveFrame(silent) {
  if (!curDs || window._curFrame == null) return false;
  const fi = window._curFrame;   // 锁定目标帧：在途期间切帧不串写
  const gi = giOf(frameList[fi], fi);
  const cl = v => Math.min(1, Math.max(0, +v));   // 钉到 0~1，防止拖拽越界被后端 400 拒收
  const valid = dboxes.map(b => {
    if (b[0] === 'poly') {
      const c = ['poly', b[1]];
      for (let k = 2; k < b.length; k++) c.push(cl(b[k]));
      return c;
    }
    return [cl(b[0]), cl(b[1]), cl(b[2]), cl(b[3]), b[4]];
  }).filter(b => b[0] === 'poly' ||
    (b[2] - b[0] > 0.002 && b[3] - b[1] > 0.002));
  const r = await api(`/api/ds/${curDs.id}/label/${gi}`, { method: 'POST',
    body: JSON.stringify({ boxes: valid }) });
  if (!r.ok) {
    toast('保存失败（修改仍在，可 Ctrl+S 重试）', 'err');
    return false;   // 失败保留 changed=true，不丢修改
  }
  if (fi === window._curFrame) dboxes = valid;   // 已切帧则不覆盖新帧数据
  changed = false;
  frameList[fi].boxes = valid.length;
  frameList[fi].reviewed = 1;   // 人工保存即视为已复核
  refreshThumbBadge(fi);
  refreshFrameItem(fi);
  toast('已保存：第 ' + (fi + 1) + ' 张（' + valid.length + ' 个框）✓', 'ok');
  return true;
}
function kbd(e) {
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
  // 空格：按一下松开 → 切换临时移动
  if (e.code === 'Space') {
    if (!e.repeat && !spaceDown) { spaceDown = true; spaceCancelled = false; }
    e.preventDefault(); return;
  }
  // Ctrl：同上；组合其他键则本次不切换
  if (e.key === 'Control') {
    if (!e.repeat && !ctrlDown) { ctrlDown = true; ctrlCancelled = false; }
    e.preventDefault(); return;
  }
  if (ctrlDown) ctrlCancelled = true;   // Ctrl+其他键：本次不切换
  if (spaceDown) spaceCancelled = true; // 空格与其他键同按：本次不切换
  // ESC：绘制中取消本次标注（起点/顶点），否则取消选中
  if (e.key === 'Escape') {
    if (pending || polyPts.length) { pending = null; polyPts = []; hoverPt = null; drawBig(); }
    else { sel = -1; drawBig(); }
    return;
  }
  if (e.key === 'ArrowLeft') { navFrame(-1); return; }
  if (e.key === 'ArrowRight') { navFrame(1); return; }
  // Ctrl+S 保存
  if (e.ctrlKey && e.key.toLowerCase() === 's') { saveFrame(); e.preventDefault(); return; }
  // Ctrl+Z 撤销
  if (e.ctrlKey && e.key.toLowerCase() === 'z') { undo(); e.preventDefault(); return; }
  // Delete 删除选中标注
  if (e.key === 'Delete' || e.key === 'Backspace') { delSel(); return; }
  // 兼容旧键位
  const k = e.key.toLowerCase();
  if (k === 'x') delSel();
  else if (k === 'z' && !e.ctrlKey) undo();
  else if (k === 's') { saveFrame(); e.preventDefault(); }
}

/* ===== 抽帧 ===== */
let pollTimer = null;
function openExtract() {
  const vids = window._taskVideos || [];
  if (!vids.length) { toast('请先为任务添加视频', 'err'); return; }
  $('exvideos').innerHTML = vids.map(v =>
    `<label style="display:flex;align-items:center;gap:8px;padding:3px 0;cursor:pointer">
     <input type="checkbox" value="${v.id}" ${curVideo && curVideo.id === v.id ? 'checked' : ''}>
     <span>${v.orig_name} <span style="color:#888">(${fmtDur(v.duration)})</span></span>
    </label>`).join('');
  $('exmsg').textContent = '';
  $('exmodal').style.display = 'flex';
}
function closeExtract() { $('exmodal').style.display = 'none'; }
async function doExtract() {
  try {
    const ids = [...document.querySelectorAll('#exvideos input:checked')].map(c => +c.value);
    if (!ids.length) { $('exmsg').textContent = '请至少勾选一个视频'; return; }
    const fps = parseFloat($('exfps').value);
    if (!(fps > 0 && fps <= 30)) { $('exmsg').textContent = '帧率须在 0~30'; return; }
    const r = await api(`/api/anno_tasks/${tid}/extract`, { method: 'POST',
      body: JSON.stringify({ video_ids: ids, fps }) });
    const res = await r.json();
    if (!res.ok) { $('exmsg').textContent = res.err || '创建任务失败'; return; }
    closeExtract();
    $('extractprog').style.display = 'block';
    $('exbar').style.width = '0%';
    $('exstate').textContent = '任务排队中…';
    pollLogs();
    pollTimer = setInterval(pollLogs, 1500);
  } catch (err) { alert('抽帧请求异常: ' + err.message); }
}

/* ===== 任务状态轮询与日志 ===== */
let pollBusy = false;
async function pollLogs() {
  if (pollBusy) return;
  pollBusy = true;
  try {
    const logs = await (await api(`/api/anno_tasks/${tid}/logs`)).json();
    window._hasRunning = logs.some(t => ['running','queued','cancelling'].includes(t.status));
    let running = null, html = '';
    for (const t of logs)
      if (['running','queued','cancelling'].includes(t.status)) running = running || t;
    for (const t of logs) {
      const isRun = t.status === 'running' || t.status === 'queued';
      if (isRun) running = t;
      const color = t.status === 'done' ? '#7c7' : t.status === 'failed' ? '#f66' : '#fc6';
      html += `<div style="margin-bottom:8px">
       <div>[<span style="color:${color}">${t.status}</span>] ${t.message || t.kind}
        ${Math.round((t.progress || 0) * 100)}%</div>`;
      if (isRun)
        html += `<div class="bar" style="margin:4px 0">
         <i style="width:${Math.round((t.progress || 0) * 100)}%"></i></div>`;
      for (const m of t.logs) html += `<div style="color:#888"> · ${m}</div>`;
      html += `</div>`;
    }
    if ($('logpanel')) { $('logpanel').innerHTML = html || '暂无记录';
    $('logpanel').scrollTop = $('logpanel').scrollHeight; }
    // 自动标注进行中：实时刷新帧状态（角标/左栏色点），不重建列表
    const preRun = logs.find(t => t.kind === 'prelabel' &&
      (t.status === 'running' || t.status === 'queued'));
    if (preRun) {
      setAnnoing(preRun.cur_index);   // 周中帧索引变化 → 标注中标记跟随移动
    } else if (window._prelabelCur != null) {
      setAnnoing(null);               // 自动标注已结束，清除标记（状态由下方刷新）
    }
    if (preRun && curDs && !frameList.__refreshing) {
      frameList.__refreshing = true;
      fetchFrames().then(async rr => {
        frameList.__refreshing = false;
        if (!rr || !rr.length) return;
        const fresh = rr;
        if (fresh.length !== frameList.length) return;   // 数量变了交给重建流程
        let changed = false;
        for (let k = 0; k < fresh.length; k++) {
          if (fresh[k].boxes !== frameList[k].boxes ||
              fresh[k].reviewed !== frameList[k].reviewed) {
            frameList[k].boxes = fresh[k].boxes;
            frameList[k].reviewed = fresh[k].reviewed;
            changed = true;
            refreshThumbBadge(k);
            refreshFrameItem(k);
          }
        }
        if (changed) {
          const sp = document.getElementById('strippos');
          if (sp && window._curFrame != null)
            sp.textContent = `第${window._curFrame + 1}张图片 共${frameList.length}个图片`;
        }
      }).catch(() => { frameList.__refreshing = false; });
    }
    // 视频缩略图下方的抽帧进度条联动
    document.querySelectorAll('.vprog').forEach(p => p.style.display = 'none');
    for (const t of logs) {
      if (t.kind === 'extract' && t.video_id &&
          (t.status === 'running' || t.status === 'queued')) {
        const bar = document.getElementById('vp' + t.video_id);
        const box = bar && bar.closest('.vprog');
        if (box) {
          box.style.display = 'block';
          bar.style.width = Math.round((t.progress || 0) * 100) + '%';
        }
      }
    }
    if (running) {
      window._runningTaskId = running.task_id;
      $('extractprog').style.display = 'block';
      $('exbar').style.width = Math.round((running.progress || 0) * 100) + '%';
      $('exstate').textContent = `${running.status} · ${running.message || ''}`;
    } else {
      window._runningTaskId = null;
      $('exstate').textContent = '暂无进行中任务';
      if (pollTimer) {
        clearInterval(pollTimer); pollTimer = null;
        datasets = await (await api('/api/datasets')).json();
        curDs = datasets.find(d => d.name === `task${tid}_pool`);
        if (curDs) {
          frameList = await fetchFrames();
          renderFrames(true);   // 任务结束刷新：保持当前帧与滚动位置
        }
      }
    }
  } finally { pollBusy = false; }
}

/* ===== 添加视频 ===== */
async function openAddVideo() {
  const vids = await (await api('/api/videos')).json();
  const have = window._taskVideoIds || new Set();
  const avail = vids.filter(v => !have.has(v.id));
  $('avlist').innerHTML = avail.length ? avail.map(v =>
    `<label style="display:flex;align-items:center;gap:8px;padding:4px 0;cursor:pointer">
     <input type="checkbox" value="${v.id}">
     <span>${v.orig_name} <span style="color:#888">(${fmtDur(v.duration)})</span></span>
    </label>`).join('')
    : '<div style="color:#888;padding:8px">所有已上传视频都已加入该任务</div>';
  $('avmsg').textContent = '';
  $('avmodal').style.display = 'flex';
}
function closeAddVideo() { $('avmodal').style.display = 'none'; }
async function doAddVideos() {
  const ids = [...document.querySelectorAll('#avlist input:checked')].map(c => +c.value);
  if (!ids.length) { $('avmsg').textContent = '请至少勾选一个视频'; return; }
  const r = await api(`/api/anno_tasks/${tid}/videos`, { method: 'POST',
    body: JSON.stringify({ video_ids: ids }) });
  const res = await r.json();
  if (!res.ok) { $('avmsg').textContent = res.err || '添加失败'; return; }
  closeAddVideo();
  loadDetail();
}

/* ===== 自动标注 ===== */
async function doPrelabel() {
  collectCls();
  const conf = parseFloat($('tconf').value);
  if (!classes.length) { toast('请先配置标签集', 'err'); return; }
  const limit = parseInt($('tlimit').value) || 0;
  if (!confirm(`标签 [${classes.map(c => c.name).join(', ')}] 置信度 ${conf}` +
      `${limit ? ` 仅前 ${limit} 帧` : ' 全部帧'}，已有标注将被覆盖。确认执行？`)) return;
  await api('/api/anno_tasks/' + tid, { method: 'PATCH',
    body: JSON.stringify({ classes, conf }) });
  const r = await api(`/api/anno_tasks/${tid}/prelabel`, { method: 'POST',
    body: JSON.stringify({ limit }) });
  const res = await r.json();
  if (!res.task_id) { toast(res.err || '发起失败', 'err'); return; }
  $('extractprog').style.display = 'block';
  $('exbar').style.width = '0%';
  $('exstate').textContent = '自动标注排队中…';
  pollLogs();
  if (!pollTimer) pollTimer = setInterval(pollLogs, 1500);
}


/* 帧列表滚轮横滚 */
(function () {
  const el = document.getElementById('strip');
  if (el) el.addEventListener('wheel', e => {
    e.preventDefault();
    el.scrollLeft += (e.deltaY || e.deltaX);
  }, { passive: false });
})();

/* 新框标签选择悬浮框（顶部搜索框：输序号快速选中） */
function showClsPop(x, y) {
  const pop = document.getElementById('clspop');
  pop.innerHTML = `
   <input id="clssearch" placeholder="输入序号快速选择" autocomplete="off"
    style="width:100%;box-sizing:border-box;margin-bottom:4px;padding:3px 6px;background:#1b1b1b;
    border:1px solid #555;border-radius:4px;color:#eee;font-size:12px;outline:none"
    oninput="clsSearch(this.value)"
    onkeydown="clsSearchKey(event)">
   <div id="clsrows2">` +
   classes.map((c, i) =>
    `<div class="clsrow" data-i="${i}" style="display:flex;align-items:center;gap:8px;padding:5px 10px;cursor:pointer;
      border-radius:4px" onmouseover="this.style.background='#333'"
      onmouseout="this.style.background='none'"
      onclick="pickCls(${i})">
     <span style="width:16px;flex:none;text-align:right;color:#888;font-size:12px">${i}</span>
     <span style="width:12px;height:12px;flex:none;border-radius:2px;background:${c.color};
      display:inline-block"></span>${c.name}</div>`).join('') +
   `</div>`;
  pop.style.display = 'block';
  pop.style.left = Math.min(x, innerWidth - 170) + 'px';
  pop.style.top = Math.min(y, innerHeight - 40 * Math.max(1, classes.length)) + 'px';
  const s = document.getElementById('clssearch');
  if (s) setTimeout(() => { s.focus(); }, 0);   // 打开即激活输入框（等 DOM 稳定后）
}
function clsSearchKey(e) {
  if (e.key === 'Enter') {   // 输完序号按 Enter 确认
    const v = e.target.value.trim(), n = Number(v);
    if (v !== '' && Number.isInteger(n) && n >= 0 && n < classes.length) pickCls(n);
    e.preventDefault(); return;
  }
  if (e.key === 'Escape') {
    e.stopPropagation();
    document.getElementById('clspop').style.display = 'none';
  }
}
function clsSearch(v) {   // 序号前缀过滤
  const rows = document.querySelectorAll('#clspop .clsrow');
  rows.forEach(r => r.style.display = (v === '' || String(r.dataset.i).startsWith(v)) ? 'flex' : 'none');
}
function pickCls(i) {
  if (sel >= 0 && dboxes[sel] && dboxes[sel][4] !== i) {
    dboxes[sel][4] = i; markChanged(); drawBig();
  }
  document.getElementById('clspop').style.display = 'none';
}
document.addEventListener('mousedown', e => {
  const pop = document.getElementById('clspop');
  if (pop && pop.style.display === 'block' && !pop.contains(e.target))
    pop.style.display = 'none';
}, true);

/* ===== 帧删除 ===== */
function refreshThumbBadge(i) {
  const thumbs = document.querySelectorAll('#strip .thumb');
  const th = thumbs[i];
  if (!th) return;
  const f = frameList[i];
  th.querySelector('.badge').style.background =
    f.reviewed ? '#3c6' : (f.boxes > 0 ? '#fc3' : '#888');
}
let delTarget = -1;
let delVideo = null;   // {id, name} 删除视频帧模式
let delSelMode = false;   // 删除勾选帧模式
function askDeleteFrame(i) {
  delTarget = i; delVideo = null; delSelMode = false;
  $('deltext').innerHTML = '将删除该帧图片及其标签文件，<span style="color:#f66">此操作不可逆</span>。';
  if (localStorage.getItem('noDelAsk') === '1') { doDeleteFrame(); return; }
  $('delmodal').style.display = 'flex';
}
function askDeleteVideoFrames(id, name) {
  delVideo = { id, name }; delTarget = -1; delSelMode = false;
  $('deltext').innerHTML = `将从任务中移除视频「${name}」并<span style="color:#f66">删除其在任务池中的全部帧及标签</span>（不删除原视频文件），此操作不可逆。`;
  $('delmodal').style.display = 'flex';
}
function askDeleteSelFrames() {
  const n = window._selFrames.size;
  if (!n || !curDs) return;
  delSelMode = true; delTarget = -1; delVideo = null;
  $('deltext').innerHTML = `将删除选中的 <b>${n}</b> 帧图片及其标签文件，<span style="color:#f66">此操作不可逆</span>。`;
  if (localStorage.getItem('noDelAsk') === '1') { doDeleteFrame(); return; }
  $('delmodal').style.display = 'flex';
}
async function doDeleteSelFrames() {
  delSelMode = false; $('delmodal').style.display = 'none';
  if (!curDs || !window._selFrames.size) return;
  const gis = [...window._selFrames];
  let ok = 0;
  for (const g of gis) {
    const r = await api(`/api/ds/${curDs.id}/frame/${g}`, { method: 'DELETE' });
    if (r.ok) ok++;
  }
  window._selFrames.clear(); window._selAnchor = null;
  await reloadFrames();
  toast(ok === gis.length ? `已删除 ${ok} 帧`
    : `已删除 ${ok}/${gis.length} 帧，部分失败`, ok ? 'ok' : 'err');
}
async function doDeleteVideoFrames() {
  if (!delVideo) return;
  const { id } = delVideo; delVideo = null;
  const r = await api(`/api/anno_tasks/${tid}/video_frames/${id}`, { method: 'DELETE' });
  const res = await r.json();
  if (!res.ok) { toast(res.err || '删除失败', 'err'); return; }
  toast(`已删除 ${res.deleted} 帧，并已从任务移除该视频`, 'info');
  window._videoFilter = null;
  window._selFrames.clear();
  await loadDetail();          // 刷新视频区间与帧池
}
async function doDeleteFrame() {
  if (delSelMode) { doDeleteSelFrames(); return; }
  if (delVideo) { $('delmodal').style.display = 'none'; doDeleteVideoFrames(); return; }
  if ($('noask') && $('noask').checked) localStorage.setItem('noDelAsk', '1');
  $('delmodal').style.display = 'none';
  if (delTarget < 0 || !curDs) return;
  const i = delTarget; delTarget = -1;
  const gi = giOf(frameList[i], i);
  const r = await api(`/api/ds/${curDs.id}/frame/${gi}`, { method: 'DELETE' });
  if (!r.ok) {
    const res = await r.json().catch(() => ({}));
    toast(res.err || '删除失败', 'err');
    return;
  }
  frameList.splice(i, 1);
  if (window._videoFilter) {   // 过滤视图：位置映射复杂化，直接重拉最稳
    await reloadFrames();
    toast(`已删除 1 帧`, 'ok');
    return;
  }
  // 原地移除该缩略图，其余不动（不重建、不丢滚动位置）
  const strip = document.getElementById('strip');
  const thumbs = strip.querySelectorAll('.thumb');
  if (thumbs[i]) thumbs[i].remove();
  // 后续缩略图的 onclick 索引整体前移一位
  strip.querySelectorAll('.thumb').forEach((th, k) => {
    const img = th.querySelector('img');
    img.setAttribute('onclick', `showFrame(${k},this)`);
    const del = th.querySelector('.delbtn');
    if (del) del.setAttribute('onclick', `askDeleteFrame(${k})`);
  });
  // 当前帧号修正：删除的是当前帧或之前的帧
  if (window._curFrame != null) {
    if (i < window._curFrame) window._curFrame -= 1;
    window._curFrame = Math.min(window._curFrame, frameList.length - 1);
  }
  if (window._viewMode === 'image') renderLeft();
  const sp = document.getElementById('strippos');
  if (sp && window._curFrame != null && frameList.length)
    sp.textContent = `第${window._curFrame + 1}张图片 共${frameList.length}个图片`;
}

/* 上一帧/下一帧 */
function navFrame(d) {
  if (window._curFrame == null || !frameList.length) return;
  const ni = Math.min(frameList.length - 1, Math.max(0, window._curFrame + d));
  if (ni === window._curFrame) return;
  jumpToFrame(ni);
}

/* ===== 人工复核 ===== */
async function markReviewed() {
  if (window._curFrame == null || !curDs) { toast('请先显示一帧', 'err'); return; }
  const gi = giOf(frameList[window._curFrame], window._curFrame);
  const i = window._curFrame;
  const r = await api(`/api/ds/${curDs.id}/review/${gi}`, { method: 'POST', body: '{}' });
  if (r.ok) {
    frameList[i].reviewed = 1;
    refreshThumbBadge(i);
    refreshFrameItem(i);
    toast('已标记复核 ✓', 'ok');
  }
}
function toggleAutoRv() {
  localStorage.setItem('autoRv', $('autorv').checked ? '1' : '0');
}

function pointInPoly(x, y, b) {
  let inside = false;
  const n = (b.length - 2) / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = b[2 + i * 2], yi = b[3 + i * 2], xj = b[2 + j * 2], yj = b[3 + j * 2];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}
function finishPoly(e) {
  if (polyPts.length < 3) { polyPts = []; drawBig(); return; }
  const cls = 0;
  const flat = ['poly', cls];
  polyPts.forEach(p => flat.push(p[0], p[1]));
  sel = dboxes.length;
  pushHist();
  dboxes.push(flat);
  markChanged();
  polyPts = []; hoverPt = null;
  if (e) showClsPop(e.clientX, e.clientY);
  drawBig();
}
cv.addEventListener('dblclick', e => {
  if (tool === 'poly' && polyPts.length >= 3) { finishPoly(e); return; }
  // 双击快速进入标注状态（四边形绘制模式）
  if (space) { tempEnter(false); e.preventDefault(); return; }   // 空格/Ctrl 切出的移动：切回
  if (tool === 'move') { setTool('rect'); e.preventDefault(); }
});

/* 右侧可折叠面板 */
document.querySelectorAll('#rightcol .card.collapsible .chead').forEach(head =>
  head.addEventListener('click', () =>
    head.parentElement.classList.toggle('collapsed')));

/* ===== 左栏视图切换：任务视频 / 任务图像 ===== */
function toggleViewMenu(e) {
  e.stopPropagation();
  const m = document.getElementById('viewmenu');
  m.style.display = m.style.display === 'block' ? 'none' : 'block';
}
document.addEventListener('click', () => {
  const m = document.getElementById('viewmenu');
  if (m) m.style.display = 'none';
});
function setView(mode) {
  const ih = document.getElementById('imghdr');
  if (ih) ih.style.display = mode === 'image' ? 'flex' : 'none';   // 全选/删除所选/定位仅图像视图
  window._viewMode = mode;
  document.getElementById('viewmenu').style.display = 'none';
  document.getElementById('colname').textContent =
    (mode === 'image' ? '任务图像' : '任务视频') + ' ▾';
  renderLeft();
}
function renderLeft() {
  const cnt = document.getElementById('colcount');
  if (window._viewMode === 'image') {
    if (cnt) cnt.textContent = frameList.length ? `共${frameList.length}个图片` : '';
    const _st = $('vlist').scrollTop;   // 保存滚动位置，重建后恢复
    $('vlist').innerHTML = frameList.length ? frameList.map((f, i) => {
      const c = f.reviewed ? '#3c6' : (f.boxes > 0 ? '#fc3' : '#888');
      const t = f.reviewed ? '已复核' : (f.boxes > 0 ? '已自动标注' : '未标注');
      const g = giOf(f, i), ck = window._selFrames.has(g) ? 'checked' : '';
      return `<div class="fitem ${i === window._curFrame ? 'cur' : ''}" data-gi="${g}" onclick="jumpToFrame(${i})" title="${t}">
       <input type="checkbox" class="fsel" ${ck}
        onclick="event.stopPropagation()"
        onchange="_selAnchor=${g};toggleSelFrame(${g}, this.checked)">
       <span class="fdot" style="background:${c}"></span>
       <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${f.file}</span>
       <button class="selhere" title="勾选从上次选中项到这里的全部帧"
        onclick="event.stopPropagation();selRangeTo(${g})">选择到这里</button>
       ${i === window._prelabelCur ? '<span class="annoing">标注中...</span>' : ''}
      </div>`;
    }).join('') : '<div style="color:#666;padding:8px;font-size:12px">任务池暂无帧</div>';
    $('vlist').scrollTop = _st;
    if (window._curFrame != null) highlightFrameItem(window._curFrame);
  } else {
    const vids = window._taskVideos || [];
    $('vlist').innerHTML = vids.map(v =>
      `<div class="vtile" id="tile${v.id}" onclick="selVideo(${v.id},'${v.orig_name}')">
       <img src="/api/videos/${v.id}/thumb" alt="">
       <button class="vdel" title="删除该视频的所有帧" onclick="event.stopPropagation();
        askDeleteVideoFrames(${v.id},'${v.orig_name}')">✕</button>
       <p>${v.orig_name}</p>
       <div class="vprog"><i id="vp${v.id}"></i></div></div>`).join('') +
      `<div class="vtile" id="addtile" style="border-style:dashed;text-align:center;
        display:flex;align-items:center;justify-content:center;min-height:126px"
        onclick="openAddVideo()"><span style="font-size:34px;color:#888">＋</span></div>`;
    if (cnt) cnt.textContent = `共${vids.length}个视频`;
  }
}
/* 正在自动标注的帧：居右显示“标注中...”（idx=null 清除） */
function setAnnoing(idx) {
  window._prelabelCur = (idx == null || idx < 0) ? null : idx;
  const items = document.querySelectorAll('#vlist .fitem');
  items.forEach(el => { const a = el.querySelector('.annoing'); if (a) a.remove(); });
  if (window._viewMode === 'image' && window._prelabelCur != null &&
      items[window._prelabelCur]) {
    const sp = document.createElement('span');
    sp.className = 'annoing'; sp.textContent = '标注中...';
    items[window._prelabelCur].appendChild(sp);
  }
}
function refreshFrameItem(i) {
  if (window._viewMode !== 'image') return;
  const el = document.querySelectorAll('#vlist .fitem')[i];
  const f = frameList[i];
  if (el && f) {
    el.querySelector('.fdot').style.background =
      f.reviewed ? '#3c6' : (f.boxes > 0 ? '#fc3' : '#888');
    el.title = f.reviewed ? '已复核' : (f.boxes > 0 ? '已自动标注' : '未标注');
  }
}
function highlightFrameItem(i) {
  document.querySelectorAll('#vlist .fitem').forEach(x => x.classList.remove('cur'));
  const el = document.querySelectorAll('#vlist .fitem')[i];
  if (el) {
    el.classList.add('cur');
    el.scrollIntoView({ block: 'nearest' });
  }
}

/* 修改后自动保存（防抖 600ms） */
let _autoT = null;
function scheduleAutoSave() {
  if (changed) {   // 自动保存默认开启（复选框已移除）：任何改动都直接保存
    if (_autoT) clearTimeout(_autoT);
    _autoT = setTimeout(() => { _autoT = null;
      saveFrame(true).catch(err =>
        toast('保存请求异常：' + ((err && err.message) || err), 'err'));
    }, 600);
  }
}

/* 命中检测：是否点在某个框的标签色块上（几何与 drawBig 绘制一致），返回框索引或 -1 */
function hitLabelChip(px, py) {
  ctx.font = '12px sans-serif';
  const chip = (lx, ly, label) =>
    px >= lx && px <= lx + ctx.measureText(label).width + 8 &&
    py >= Math.max(0, ly - 16) && py <= Math.max(0, ly - 16) + 16;
  for (let i = dboxes.length - 1; i >= 0; i--) {
    const b = dboxes[i];
    if (b[0] === 'poly') {
      const cls = b[1], name = classes[cls] ? classes[cls].name : '#' + cls;
      if (chip(b[2] * cv.width, b[3] * cv.height, name)) return i;
    } else {
      const cls = b[4], name = classes[cls] ? classes[cls].name : '#' + cls;
      if (chip(b[0] * cv.width, b[1] * cv.height, name)) return i;
    }
  }
  return -1;
}

/* 标签色块右键：弹出标签列表，点选替换该框类别 */
cv.addEventListener('contextmenu', e => {
  e.preventDefault();
  if ((tool !== 'move' && !space) || pending || polyPts.length) return;
  const r = cv.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
  const hit = hitLabelChip(px, py);
  if (hit < 0) return;
  sel = hit;
  pushHist();          // 支持撤销；pushHist 会触发自动保存
  drawBig();           // 高亮选中框
  showClsPop(e.clientX, e.clientY);
});

/* 移动模式命中处理（工具=move 或 按住空格时） */
function moveModeHit(e, px, py, x, y) {
  let hit = -1;
  for (let i = dboxes.length - 1; i >= 0; i--) {
    const b = dboxes[i];
    if (b[0] === 'poly') {
      if (pointInPoly(x, y, b)) { hit = i; break; }
    } else {
      const L = Math.min(b[0], b[2]) * cv.width, T = Math.min(b[1], b[3]) * cv.height,
            R = Math.max(b[0], b[2]) * cv.width, B = Math.max(b[1], b[3]) * cv.height;
      const near = px >= L - 10 && px <= R + 10 && py >= T - 10 && py <= B + 10;
      const inside = px >= L && px <= R && py >= T && py <= B;
      if (inside || near) { hit = i; break; }
    }
  }
  if (hit >= 0) {
    sel = hit; const b = dboxes[hit];
    pushHist();
    if (b[0] === 'poly') {
      let vi = -1;
      for (let k = 0; k < (b.length - 2) / 2; k++) {
        const vx = b[2 + k * 2] * cv.width, vy = b[3 + k * 2] * cv.height;
        if (Math.hypot(px - vx, py - vy) < 9) { vi = k; break; }
      }
      if (vi >= 0) drag = { mode: 'polyv', bi: hit, vi, orig: [...b] };
      else drag = { mode: 'polymove', sx: x, sy: y, orig: [...b] };
    } else {
      const L = Math.min(b[0], b[2]) * cv.width, T = Math.min(b[1], b[3]) * cv.height,
            R = Math.max(b[0], b[2]) * cv.width, B = Math.max(b[1], b[3]) * cv.height;
      const TOL = 10;
      const nearL = Math.abs(px - L) < TOL, nearR = Math.abs(px - R) < TOL;
      const nearT = Math.abs(py - T) < TOL, nearB = Math.abs(py - B) < TOL;
      let grip = null;
      if (nearL && nearT) grip = 'LT'; else if (nearR && nearT) grip = 'RT';
      else if (nearL && nearB) grip = 'LB'; else if (nearR && nearB) grip = 'RB';
      else if (nearL) grip = 'L'; else if (nearR) grip = 'R';
      else if (nearT) grip = 'T'; else if (nearB) grip = 'B';
      drag = grip ? { mode: 'resize', grip, orig: [...b] }
                  : { mode: 'move', sx: x, sy: y, orig: [...b] };
    }
  } else {
    sel = -1;
  }
  drawBig();
}

/* 全局错误浮窗提示（防静默失败） */
window.addEventListener('error', e => {
  toast('脚本错误: ' + (e.message || 'unknown'), 'err');
});
window.addEventListener('unhandledrejection', e => {
  toast('异步错误: ' + ((e.reason && e.reason.message) || e.reason || 'unknown'), 'err');
});

/* 大图区滚轮：上下翻页（切帧） */
document.getElementById('bigframe').addEventListener('wheel', e => {
  e.preventDefault();
  navFrame(e.deltaY > 0 ? 1 : -1);
}, { passive: false });

/* ===== 导出 ===== */
async function doExport() {
  const path = $('expath').value.trim();
  const format = $('exfmt').value;
  if (!path) { $('exmsg2').textContent = '请填写导出目录'; return; }
  $('exmsg2').textContent = '导出中…';
  const r = await api(`/api/anno_tasks/${tid}/export`, { method: 'POST',
    body: JSON.stringify({ path, format }) });
  const res = await r.json();
  if (!res.ok) { $('exmsg2').textContent = res.err || '导出失败'; return; }
  $('exmsg2').textContent = `✓ 已导出 ${res.images} 张图到 ${res.path}`;
}

/* ===== 目录浏览器 ===== */
let fsCurPath = '';
async function openFsBrowser() {
  fsCurPath = $('expath').value.trim() ||
    '/mnt/hgfs/VMShare/datasets';
  await fsLoad();
  $('fsmodal').style.display = 'flex';
}
async function fsLoad() {
  $('fslist').innerHTML = '<div style="color:#888;padding:6px">加载中…</div>';
  const r = await api('/api/fs/dirs?path=' + encodeURIComponent(fsCurPath));
  if (!r.ok) {
    $('fslist').innerHTML = '<div style="color:#f66;padding:6px">无法打开该目录</div>';
    $('fscur').textContent = fsCurPath;
    return;
  }
  const d = await r.json();
  fsCurPath = d.path;
  $('fscur').textContent = fsCurPath;
  $('fslist').innerHTML = d.dirs.length
    ? d.dirs.map(x => `<div class="fsitem" onclick="fsEnter('${x.replace(/'/g, "\\'")}')"
        style="padding:4px 8px;cursor:pointer;border-radius:3px;font-size:13px"
        onmouseover="this.style.background='#444'" onmouseout="this.style.background='none'">📁 ${x}</div>`).join('')
    : '<div style="color:#888;padding:6px">（无子目录）</div>';
}
async function fsEnter(name) {
  fsCurPath = fsCurPath.replace(/\/$/, '') + '/' + name;
  await fsLoad();
}
async function fsUp() {
  const r = await api('/api/fs/dirs?path=' + encodeURIComponent(fsCurPath));
  if (r.ok) {
    const d = await r.json();
    fsCurPath = d.parent;
  } else {
    fsCurPath = fsCurPath.replace(/\/[^/]+$/, '') || '/';
  }
  await fsLoad();
}
function fsPick() {
  $('expath').value = fsCurPath;
  $('fsmodal').style.display = 'none';
}

/* ===== 发布数据集 ===== */
async function doPublish() {
  const name = window._taskName || '';
  if (!confirm(`将当前任务池导出并发布到数据集广场${name ? `（${name}）` : ''}？`)) return;
  $('exmsg2').textContent = '发布中…';
  const r = await api(`/api/anno_tasks/${tid}/publish`, { method: 'POST',
    body: JSON.stringify({}) });
  const res = await r.json();
  if (!res.ok) { $('exmsg2').textContent = res.err || '发布失败'; return; }
  $('exmsg2').textContent = `✓ 已发布 ${res.images} 张图，可到「数据集广场」查看`;
}

/* 双击任务名编辑 */
(function () {
  const el = document.getElementById('tTitle');
  if (!el) return;
  el.title = '双击编辑任务名';
  el.style.cursor = 'text';
  el.addEventListener('dblclick', () => {
    const old = el.textContent;
    el.innerHTML = `<input id="tnameedit" value="${old.replace(/"/g, '&quot;')}"
      style="font-size:18px;font-weight:600;background:#333;color:#eee;
      border:1px solid #0e639c;border-radius:4px;padding:2px 8px;width:280px">`;
    const inp = document.getElementById('tnameedit');
    inp.focus(); inp.select();
    let done = false;
    const save = async () => {
      if (done) return; done = true;
      const name = inp.value.trim();
      if (!name || name === old) { el.textContent = old; return; }
      const r = await api('/api/anno_tasks/' + tid, { method: 'PATCH',
        body: JSON.stringify({ name }) });
      const res = await r.json();
      el.textContent = r.ok ? name : old;
      if (!r.ok) alert(res.err || '重命名失败');
      window._taskName = el.textContent;
    };
    inp.addEventListener('blur', save);
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); save(); }
      if (e.key === 'Escape') { done = true; el.textContent = old; }
    });
  });
})();

/* ===== 上传标签文件（每行一个标签，自动配色） ===== */
document.getElementById('clsfile').addEventListener('change', async e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  const text = await f.text();
  const names = [...new Set(text.split(/\r?\n/).map(x => x.trim()).filter(Boolean))];
  if (!names.length) { $('tcmsg').textContent = '文件中没有有效标签'; return; }
  classes = names.map((n, i) => ({ name: n, color: uniqColor(i) }));
  renderClsRows();
  // 自动保存
  const r = await api('/api/anno_tasks/' + tid, { method: 'PATCH',
    body: JSON.stringify({ classes }) });
  $('tcmsg').textContent = r.ok ? `已导入 ${names.length} 个标签并保存 ✓`
    : '导入成功但保存失败，请手动保存';
  if (r.ok && cv.dataset.nw) drawBig();
});

/* 唯一颜色：黄金角 HSL -> HEX（任意数量不重复） */
function uniqColor(i) {
  const h = (i * 137.508) % 360;
  const s = 0.65, l = 0.55;
  const f = n => {
    const k = (n + h / 30) % 12;
    const c = l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(255 * c).toString(16).padStart(2, '0');
  };
  return '#' + f(0) + f(8) + f(4);
}

/* ===== 停止当前任务 ===== */
async function stopRunningTask() {
  if (!window._runningTaskId) { toast('当前没有进行中的任务', 'err'); return; }
  if (!confirm('确认停止当前任务？已完成的部分会保留。')) return;
  const r = await api(`/api/tasks/${window._runningTaskId}/cancel`, { method: 'POST',
    body: '{}' });
  const res = await r.json();
  if (!res.ok) { toast(res.err || '停止失败', 'err'); return; }
  $('exstate').textContent = '正在停止…';
}

/* ===== 帧选中体系（左栏图像列表 + strip 缩略图联动，键=全局帧号 gi） ===== */
window._selFrames = new Set();
window._selAnchor = null;   // 最后一次点击勾选的复选框（gi），「选择到这里」起点

function toggleSelFrame(gi, on) {
  if (on) window._selFrames.add(gi); else {
    window._selFrames.delete(gi);
    if (window._selAnchor === gi) window._selAnchor = null;
  }
  syncSelUI();
}
function locateUnreviewed() {   // 定位第一个未复核（非绿色）帧并打开
  const i = frameList.findIndex(f => !f.reviewed);
  if (i < 0) { toast('没有未复核的帧，全部已复核 ✓', 'info'); return; }
  jumpToFrame(i);
}
function selAllImgs(on) {   // 左栏列表全选（当前显示的帧）
  frameList.forEach(f => {
    const g = giOf(f);
    if (on) window._selFrames.add(g); else window._selFrames.delete(g);
  });
  if (!on) window._selAnchor = null;
  syncSelUI();
}
function selAllStrip(on) { selAllImgs(on); }   // strip 与列表同源，逻辑一致

function syncSelUI() {
  const n = window._selFrames.size;
  const sc = document.getElementById('selcount');
  if (sc) sc.textContent = n ? `已选 ${n} 帧` : '';
  document.querySelectorAll('#vlist .fitem').forEach(el => {
    const cb = el.querySelector('.fsel');
    if (cb) cb.checked = window._selFrames.has(+el.dataset.gi);
  });
  document.querySelectorAll('#strip .fselthumb').forEach(cb => {
    cb.checked = window._selFrames.has(+cb.dataset.gi);
  });
  const sa = document.getElementById('selallimgs');
  if (sa) sa.checked = frameList.length > 0 &&
    frameList.every(f => window._selFrames.has(giOf(f)));
  const ss = document.getElementById('selallstrip');
  if (ss) ss.checked = sa ? sa.checked : false;
  // 删除所选按钮：有勾选才可用，并显示数量
  ['delselimgs', 'delselstrip'].forEach(id => {
    const b = document.getElementById(id);
    if (b) { b.disabled = !n; b.textContent = n ? `删除所选(${n})` : '删除所选'; }
  });
  const rs = document.getElementById('rangestat');
  if (rs) {
    if (n) { rs.textContent = '统计中…'; loadRangeStat(); }
    else { rs.textContent = '未勾选图像'; }
  }
  const rb = document.getElementById('relabelsel');
  if (rb) rb.style.display = n ? 'block' : 'none';
}

/* 范围选择：从锚点 gi 到当前 gi（按当前显示顺序）之间的全部帧选中 */
function selRangeTo(gi) {
  const order = frameList.map(f => giOf(f));
  const a = order.indexOf(window._selAnchor), b = order.indexOf(gi);
  if (a < 0 || b < 0) return;
  const [lo, hi] = a < b ? [a, b] : [b, a];
  for (let k = lo; k <= hi; k++) window._selFrames.add(order[k]);
  syncSelUI();
}

/* ===== 标签统计（视频范围 / 选中范围） + 双击改名 ===== */
function statRowHtml(st) {
  const c = classes[st.cls] ? classes[st.cls].color : '#f33';
  const name = classes[st.cls] ? classes[st.cls].name : '#' + st.cls;
  return `<div class="statrow" data-cls="${st.cls}">
   <span class="fdot" style="background:${c}"></span>
   <span class="statname" style="flex:1;cursor:text" title="双击改为其他标签">${name}</span>
   <span style="color:#888">${st.count}</span>
  </div>`;
}
function bindStatRename(container, scopeBody) {
  container.querySelectorAll('.statrow .statname').forEach(el => {
    el.ondblclick = () => {
      const row = el.closest('.statrow'), cls = +row.dataset.cls;
      el.innerHTML = `<select style="width:100%;background:#333;color:#eee;border:1px solid #0e639c;border-radius:3px;font-size:12px">
        ${classes.map((c, i) => `<option value="${i}" ${i === cls ? 'selected' : ''}>${c.name}</option>`).join('')}
        <option value="-1" style="color:#f66">🗑 删除该标签的标注</option>
      </select>`;
      const sel = el.querySelector('select');
      sel.focus();
      const done = async () => {
        const to = +sel.value;
        if (to === cls) { el.textContent = classes[cls] ? classes[cls].name : '#' + cls; return; }
        const delMode = to === -1;
        if (delMode && !confirm(`确认删除该范围内「${classes[cls].name}」的全部标注？不可自动撤销（有备份）。`)) {
          el.textContent = classes[cls].name; return;
        }
        const r = await api(`/api/ds/${curDs.id}/rename_label`, { method: 'POST',
          body: JSON.stringify({ task_id: +tid, ...scopeBody, from: cls, to }) });
        const res = await r.json();
        if (!res.ok) { toast(res.err || (delMode ? '删除失败' : '改名失败'), 'err');
          el.textContent = classes[cls].name; return; }
        toast(delMode ? `已删除 ${res.boxes} 个框（${res.frames} 帧）`
                      : `已替换 ${res.boxes} 个框（${res.frames} 帧）`, 'ok');
        if (delMode) { row.remove(); }
        else {
          el.textContent = classes[to].name;
          row.dataset.cls = to;
          row.querySelector('.fdot').style.background = classes[to].color;
        }
        await refreshStats();            // 三个分区统计全部刷新
        if (frameList.length) { await showFrame(window._curFrame,
          document.querySelectorAll('#strip .thumb img')[window._curFrame]); }
      };
      sel.onchange = done;
      sel.onblur = done;
    };
  });
}

let _videoStatBody = null, _rangeStatBody = null;
function scopeVideoBody() { return _videoStatBody; }
async function refreshStats() {
  // 当前视频统计
  const vs = document.getElementById('videostat');
  if (vs && window._videoFilter) {
    _videoStatBody = { video_id: window._videoFilter };
    const r = await api(`/api/ds/${curDs.id}/label_stats`, { method: 'POST',
      body: JSON.stringify({ task_id: +tid, video_id: window._videoFilter }) });
    const res = await r.json();
    if (res.ok) {
      const name = (window._taskVideos || []).find(v => v.id === window._videoFilter);
      $('vstatname').textContent = name ? name.orig_name : '';
      vs.innerHTML = res.stats.length
        ? res.stats.map(statRowHtml).join('')
        : '该视频暂无标注';
      vs.insertAdjacentHTML('beforeend',
        `<div style="color:#666;margin-top:4px">共 ${res.frames} 帧有标注（双击标签名可改）</div>`);
      bindStatRename(vs, _videoStatBody);
    }
  } else if (vs) { vs.textContent = '未选择视频（点击左侧视频卡片）'; $('vstatname').textContent = ''; }
  // 所选范围统计
  const rs = document.getElementById('rangestat');
  if (rs && window._selFrames.size) {
    _rangeStatBody = { gis: [...window._selFrames] };
    const r = await api(`/api/ds/${curDs.id}/label_stats`, { method: 'POST',
      body: JSON.stringify({ task_id: +tid, gis: [...window._selFrames] }) });
    const res = await r.json();
    if (res.ok) {
      $('rstatname').textContent = `${window._selFrames.size} 帧`;
      rs.innerHTML = res.stats.length
        ? res.stats.map(statRowHtml).join('')
        : '所选范围内暂无标注';
      rs.insertAdjacentHTML('beforeend',
        `<div style="color:#666;margin-top:4px">共 ${res.frames} 帧有标注（双击标签名可改）</div>`);
      bindStatRename(rs, _rangeStatBody);
    }
  } else if (rs) { rs.textContent = '未勾选图像'; $('rstatname').textContent = ''; }
}
async function loadRangeStat() { await refreshStats(); }

/* ===== 批量替换（范围=选中集合） ===== */
function openBatchRelabel() {
  if (!window._selFrames.size) { toast('请先勾选图像帧', 'err'); return; }
  const from = prompt(`把所选 ${window._selFrames.size} 帧中的标签：\n` +
    classes.map((c, i) => `${i}. ${c.name}`).join('\n') +
    '\n\n输入要替换的标签序号：');
  if (from == null || from === '') return;
  const to = prompt('替换为标签序号：');
  if (to == null || to === '') return;
  const fi = +from, ti = +to;
  if (isNaN(fi) || isNaN(ti) || fi === ti ||
      !classes[fi] || !classes[ti]) { toast('序号无效', 'err'); return; }
  if (!confirm(`确认把 ${window._selFrames.size} 帧中「${classes[fi].name}」的框全部改为「${classes[ti].name}」？`)) return;
  api(`/api/ds/${curDs.id}/rename_label`, { method: 'POST',
    body: JSON.stringify({ task_id: +tid, gis: [...window._selFrames], from: fi, to: ti }) })
    .then(async r => {
      const res = await r.json();
      if (!res.ok) { toast(res.err || '替换失败', 'err'); return; }
      toast(`替换完成：${res.boxes} 个框 / ${res.frames} 帧` +
        (res.failed.length ? `，${res.failed.length} 帧失败` : ''), 'ok');
      await refreshStats();
      if (frameList.length) showFrame(window._curFrame,
        document.querySelectorAll('#strip .thumb img')[window._curFrame]);
    });
}
