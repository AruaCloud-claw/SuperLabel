/* 总览页 */
async function onPageReady() {
  const s = await (await api('/api/stats')).json();
  const tot = s.datasets.reduce((a, d) => a + d.total, 0);
  const lab = s.datasets.reduce((a, d) => a + d.labeled, 0);
  $('statcards').innerHTML =
    `<div class="stat"><b>${s.datasets.length}</b>数据集</div>` +
    `<div class="stat"><b>${tot}</b>总帧数</div>` +
    `<div class="stat"><b>${lab}</b>已标注帧</div>` +
    `<div class="stat"><b>${tot ? (lab / tot * 100).toFixed(1) : 0}%</b>总体覆盖</div>`;
  $('statds').innerHTML = s.datasets.map(d =>
    `<div style="margin:8px 0">${d.name} · ${d.labeled}/${d.total}
     <div class="bar"><i style="width:${d.coverage * 100}%"></i></div></div>`).join('')
    + (s.by_user ? `<hr style="border-color:#333"><div>${s.by_user.map(u =>
      `${u.username}: ${u.saves} 次保存`).join(' · ')}</div>` : '');
}
