/* 登录页逻辑 */
async function doLogin(){
  const r = await fetch('/api/login',{method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({username:document.getElementById('u').value,
      password:document.getElementById('p').value})});
  if(!r.ok){document.getElementById('err').textContent=(await r.json()).err;return}
  localStorage.setItem('token',(await r.json()).token);
  location.href='/ui/overview.html';
}
document.addEventListener('keydown',e=>{if(e.key==='Enter')doLogin()});
