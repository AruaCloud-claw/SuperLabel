/* 后台管理页：用户注册/角色/停用/重置密码 */
function onPageReady() { loadUsers(); }

async function loadUsers() {
  const us = await (await api('/api/users')).json();
  document.getElementById('utab').innerHTML =
    '<tr><th>ID</th><th>用户名</th><th>姓名</th><th>角色</th><th>状态</th><th>操作</th></tr>' +
    us.map(u => `<tr><td>${u.id}</td><td>${u.username}</td><td>${u.display_name || ''}</td>
     <td>${u.role}</td><td>${u.is_active ? '启用' : '停用'}</td>
     <td><button onclick="toggle(${u.id},${u.is_active ? 0 : 1})">${u.is_active ? '停用' : '启用'}</button>
     <button onclick="resetPw(${u.id})">重置密码</button></td></tr>`).join('');
}
async function addUser() {
  const r = await api('/api/users', { method: 'POST', body: JSON.stringify({
    username: $('nu').value, password: $('np').value,
    role: $('nr').value, display_name: $('nd').value }) });
  if (!r.ok) { $('umsg').textContent = (await r.json()).err; return; }
  $('umsg').textContent = '已注册 ✓'; $('nu').value = $('np').value = ''; loadUsers();
}
async function toggle(id, active) {
  await api('/api/users/' + id, { method: 'PATCH', body: JSON.stringify({ is_active: active }) });
  loadUsers();
}
async function resetPw(id) {
  const p = prompt('新密码'); if (!p) return;
  await api('/api/users/' + id, { method: 'PATCH', body: JSON.stringify({ password: p }) });
  $('umsg').textContent = '密码已重置';
}
