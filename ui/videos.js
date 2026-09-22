/* 数据集管理页：原始视频文件上传/列表/删除/详情入口 */
let selFiles = [];

function onPageReady() { loadVideos(); }

async function loadVideos() {
  const list = await (await api('/api/videos')).json();
  window._videos = list;
  $('vtab').innerHTML = '<tr><th>ID</th><th>文件名</th><th>大小</th><th>时长</th><th>分辨率</th>' +
    '<th>帧率</th><th>上传人</th><th>上传时间</th><th>操作</th></tr>' +
    (list.length ? list.map(v => `<tr>
      <td>${v.id}</td><td>${v.orig_name}</td><td>${fmtSize(v.size)}</td>
      <td>${fmtDur(v.duration)}</td><td>${v.width}×${v.height}</td><td>${v.fps}</td>
      <td>${v.uploader || ''}</td><td>${v.created_at}</td>
      <td><button onclick="location.href='/ui/video_detail.html?id=${v.id}'">详情</button>
      <button class="warn" onclick="vDel(${v.id},'${v.orig_name}')">删除</button></td></tr>`).join('')
     : '<tr><td colspan=9 style="color:#666">暂无视频，点击右上「上传视频」</td></tr>');
}

/* ===== 上传悬浮表单 ===== */
function openUpload() { selFiles = []; renderFlist(); $('upmsg').textContent = '';
  $('upmodal').style.display = 'flex'; }
function closeUpload() { $('upmodal').style.display = 'none'; loadVideos(); }
function renderFlist() {
  $('flist').innerHTML = selFiles.map((f, i) =>
    `<div style="display:flex;justify-content:space-between;padding:3px 0">
     <span>${f.name} (${fmtSize(f.size)})</span>
     <span style="cursor:pointer;color:#f66" onclick="selFiles.splice(${i},1);renderFlist()">✕</span></div>`).join('');
}
$('dropzone').addEventListener('click', () => $('vfiles').click());
$('vfiles').addEventListener('change', e => {
  selFiles = selFiles.concat([...e.target.files]); renderFlist(); e.target.value = '';
});
const dz = document.getElementById('dropzone');
dz.addEventListener('dragover', e => { e.preventDefault(); dz.style.borderColor = '#4cc'; });
dz.addEventListener('dragleave', () => dz.style.borderColor = '#555');
dz.addEventListener('drop', e => { e.preventDefault(); dz.style.borderColor = '#555';
  selFiles = selFiles.concat([...e.dataTransfer.files].filter(f =>
    f.name.toLowerCase().match(/\.(mp4|avi|mov|mkv|flv|wmv|webm)$/))); renderFlist(); });

async function doUpload() {
  if (!selFiles.length) { $('upmsg').textContent = '请先添加文件'; return; }
  for (let i = 0; i < selFiles.length; i++) {
    $('upmsg').textContent = `上传 ${i + 1}/${selFiles.length}: ${selFiles[i].name}`;
    const fd = new FormData(); fd.append('videos', selFiles[i]);
    const r = await fetch('/api/videos', { method: 'POST', headers: H, body: fd });
    if (!r.ok) { $('upmsg').textContent = (await r.json()).err || '上传失败'; return; }
    const res = await r.json();
    if (res.skipped.length) $('upmsg').textContent = '部分跳过: ' +
      res.skipped.map(s => s[0] + '(' + s[1] + ')').join(', ');
  }
  $('upmsg').textContent = '✓ 全部上传完成';
  selFiles = []; renderFlist();
  setTimeout(closeUpload, 800);
}

async function vDel(id, name) {
  if (!confirm(`确认删除视频「${name}」？此操作不可恢复。`)) return;
  const r = await api('/api/videos/' + id, { method: 'DELETE' });
  if (r.ok) loadVideos();
}
