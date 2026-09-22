/* 数据集广场：卡片瀑布流 */
function onPageReady() { loadGallery(); }

async function loadGallery() {
  const list = await (await api('/api/published')).json();
  if (!list.length) {
    $('ggrid').innerHTML = '<div style="color:#666">暂无发布的数据集，去任务详情点「发布数据集」吧</div>';
    return;
  }
  $('ggrid').innerHTML = list.map(d => {
    const size = d.size_bytes > 1e9 ? (d.size_bytes / 1e9).toFixed(2) + ' GB'
      : (d.size_bytes / 1e6).toFixed(1) + ' MB';
    return `<div class="gcard" onclick="location.href='/ui/gallery_detail.html?id=${d.id}'">
     <img src="/api/published/${d.id}/thumb" loading="lazy" alt="">
     <div class="ginfo">
      <b>${d.name}</b>
      <div class="gmeta">🖼 ${d.image_count} 张 · ${size}</div>
      <div class="gmeta">发布: ${d.publisher || ''} · ${d.created_at}</div>
     </div>
    </div>`;
  }).join('');
}
