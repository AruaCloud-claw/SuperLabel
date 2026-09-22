/* 任务广场：标注任务列表/新建 */
function onPageReady() { loadTasks(); }

async function loadTasks() {
  const list = await (await api('/api/anno_tasks')).json();
  $('ttab').innerHTML = '<tr><th>ID</th><th>任务名</th><th>视频数</th><th>备注</th>' +
    '<th>状态</th><th>创建人</th><th>创建时间</th><th>操作</th></tr>' +
    (list.length ? list.map(t => `<tr>
      <td>${t.id}</td><td>${t.name}</td><td>${t.video_count}</td>
      <td>${t.note || ''}</td><td>${t.status}</td><td>${t.creator || ''}</td>
      <td>${t.created_at}</td>
      <td><button onclick="tDetail(${t.id})">详情</button>
      <button class="warn" onclick="tDel(${t.id},'${t.name}')">删除</button></td></tr>`).join('')
     : '<tr><td colspan=8 style="color:#666">暂无任务，点击右上「新建任务」</td></tr>');
}

async function openNew() {
  $('tn').value = ''; $('tnote').value = ''; $('tmsg').textContent = '';
  const vids = await (await api('/api/videos')).json();
  if (!vids.length) { $('tmsg').textContent = '请先在「原始视频管理」上传视频'; return; }
  $('tsel').innerHTML = vids.map(v =>
    `<label style="display:block;padding:2px 0;cursor:pointer">
     <input type="checkbox" value="${v.id}"> ${v.orig_name} (${fmtDur(v.duration)})</label>`).join('');
  $('ntmodal').style.display = 'flex';
}
function closeNew() { $('ntmodal').style.display = 'none'; loadTasks(); }
async function createTask() {
  const name = $('tn').value.trim();
  const video_ids = [...document.querySelectorAll('#tsel input:checked')]
    .map(c => +c.value);
  if (!name) { $('tmsg').textContent = '请填任务名'; return; }
  if (!video_ids.length) { $('tmsg').textContent = '请至少选择一个数据来源视频'; return; }
  const r = await api('/api/anno_tasks', { method: 'POST', body: JSON.stringify({
    name, video_ids, note: $('tnote').value }) });
  if (!r.ok) { $('tmsg').textContent = (await r.json()).err; return; }
  closeNew();
}
async function tDel(id, name) {
  if (!confirm(`确认删除任务「${name}」？已抽帧数据不受影响。`)) return;
  const r = await api('/api/anno_tasks/' + id, { method: 'DELETE' });
  if (r.ok) loadTasks();
}
function tDetail(id) { location.href = '/ui/task_detail.html?id=' + id; }
