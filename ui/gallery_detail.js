/* 数据集详情页：元信息 + 全量图片网格预览（懒加载分页） */
const pid = new URLSearchParams(location.search).get('id');
let files = [], loaded = 0;

function onPageReady() { loadDetail(); }

async function loadDetail() {
  const list = await (await api('/api/published')).json();
  const d = list.find(x => x.id == pid);
  if (!d) { $('dTitle').textContent = '数据集不存在'; $('dMeta').textContent = ''; return; }
  const size = d.size_bytes > 1e9 ? (d.size_bytes / 1e9).toFixed(2) + ' GB'
    : (d.size_bytes / 1e6).toFixed(1) + ' MB';
  const classes = JSON.parse(d.classes_json || '[]');
  $('dTitle').textContent = d.name;
  $('dMeta').innerHTML =
    `🖼 图片 <b>${d.image_count}</b> 张 · 💾 大小 <b>${size}</b> · ` +
    `🏷 标签 <b>${classes.join(', ') || '-'}</b> · ` +
    `👤 ${d.publisher || ''} · ${d.created_at}`;
  loadMore();
  window.addEventListener('scroll', () => {
    if (innerHeight + scrollY >= document.body.offsetHeight - 400) loadMore();
  });
}

async function loadMore() {
  if (loaded >= files.length) {
    const r = await api(`/api/published/${pid}/images?offset=${loaded}&limit=60`);
    const d = await r.json();
    if (!d.files.length && loaded === 0) {
      $('dgrid').innerHTML = '<div style="color:#666">无图片</div>';
      return;
    }
    files = files.concat(d.files);
  }
  const frag = [];
  const end = Math.min(files.length, loaded + 60);
  for (let i = loaded; i < end; i++) {
    frag.push(`<div class="dcell" onclick="viewImg('${files[i]}')">
     <img loading="lazy" src="/api/published/${pid}/image/${files[i]}?token=${T}" alt="">
     <p>${files[i]}</p></div>`);
  }
  $('dgrid').insertAdjacentHTML('beforeend', frag.join(''));
  loaded = end;
}

function viewImg(f) {
  $('viewimg').src = `/api/published/${pid}/image/${f}?token=${T}`;
  $('viewer').style.display = 'flex';
}
