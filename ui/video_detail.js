/* 视频详情页：播放器 + 元信息 + 抽帧入口 */
const vid = new URLSearchParams(location.search).get('id');

function onPageReady() { loadDetail(); }

async function loadDetail() {
  const list = await (await api('/api/videos')).json();
  const v = list.find(x => x.id == vid);
  if (!v) { $('vdTitle').textContent = '视频不存在'; return; }
  window._v = v;
  $('vdTitle').textContent = v.orig_name;
  $('player').src = `/api/videos/${vid}/file?token=${T}`;
  const rows = [['文件名', v.orig_name], ['大小', fmtSize(v.size)],
   ['时长', fmtDur(v.duration)], ['分辨率', v.width + '×' + v.height],
   ['帧率', v.fps ? v.fps + ' fps' : '-'], ['上传人', v.uploader || ''],
   ['上传时间', v.created_at], ['存储路径', v.path]];
  $('vinfo').innerHTML = rows.map(r =>
    `<tr><th style="width:80px">${r[0]}</th><td>${r[1]}</td></tr>`).join('');
}

function extractHere() {
  const name = prompt('数据集名', window._v ? window._v.orig_name.replace(/\.[^.]+$/, '') : '');
  if (!name) return;
  const fps = prompt('抽帧帧率（每秒抽几帧）', '5'); if (!fps) return;
  $('xdmsg').textContent = '抽帧中，请稍候…';
  api('/api/datasets', { method: 'POST', body: JSON.stringify({
    name, frame_dir: window._v.path, video_path: window._v.path,
    classes: ['excavator'] }) })
  .then(async r => {
    if (!r.ok) { $('xdmsg').textContent = (await r.json()).err; return; }
    const ds = await r.json();
    return api(`/api/ds/${ds.id}/extract`, { method: 'POST', body: JSON.stringify({
      video_path: window._v.path, fps: parseFloat(fps) }) }).then(async r2 => {
      const res = await r2.json();
      $('xdmsg').textContent = res.ok
        ? `✓ 已创建数据集「${name}」，抽帧 ${res.frames} 帧`
        : res.err;
    });
  });
}
