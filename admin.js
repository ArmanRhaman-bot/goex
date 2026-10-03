const $=s=>document.querySelector(s);const $$=s=>[...document.querySelectorAll(s)];
let tab="dashboard",settings={};

document.addEventListener("DOMContentLoaded",async()=>{try{await api("/api/admin/me");}catch{renderLogin();return}
  $$("#adminApp .admin-nav button").forEach(b=>b.onclick=()=>{tab=b.dataset.tab;render()});
  $("#logout").onclick=async()=>{await api("/api/admin/logout",{method:"POST"});location.reload()};
  render();
});
function render(){ $$("#adminApp .admin-nav button").forEach(b=>b.classList.toggle("active",b.dataset.tab===tab)); if(tab==="dashboard")dashboard();if(tab==="settings")settingsPage();if(tab==="users")usersPage();if(tab==="tasks")tasksPage(); }
async function dashboard(){const s=await api("/api/admin/stats");$("#adminContent").innerHTML=`<h2>Dashboard</h2><div class="admin-grid">${card("Users",s.users)}${card("Paid deposits",s.deposits)}${card("Completed withdrawals",s.withdrawals)}${card("Balance",Number(s.totalBalance||0).toFixed(4)+" USDT")}</div>`}
function card(a,b){return `<div class="card"><div class="muted">${a}</div><div style="font-size:27px;font-weight:800;margin-top:7px">${b}</div></div>`}
async function settingsPage(){settings=await api("/api/admin/settings");$("#adminContent").innerHTML=`<h2>Settings</h2><div class="card">
${field("App name","appName",settings.appName)}${field("Channel username","channelUsername",settings.channelUsername)}${field("Channel join URL","channelJoinUrl",settings.channelJoinUrl)}
${field("Admin-entry Telegram ID","adminEntryUserId",settings.adminEntryUserId)}${field("Referral coins","referralCoins",settings.referralCoins)}${field("Referral deposit %","referralDepositPercent",settings.referralDepositPercent)}
${field("Daily check-in coins","dailyCheckinCoins",settings.dailyCheckinCoins)}${field("Gift boxes / referral","giftBoxesPerReferral",settings.giftBoxesPerReferral)}
${field("Gift minimum","giftMin",settings.giftMin)}${field("Gift maximum","giftMax",settings.giftMax)}${field("Default gift boxes","giftDefaultBoxes",settings.giftDefaultBoxes)}
${field("Minimum deposit USDT","minDeposit",settings.minDeposit||0.1)}${field("Minimum withdrawal USDT","minWithdrawal",settings.minWithdrawal)}
${field("Coin USD rate","coinUsdRate",settings.coinUsdRate)}${field("Coin daily %","coinDailyPercent",settings.coinDailyPercent)}
${field("OxaPay Merchant API key","oxapayMerchantKey","",true,settings.hasMerchantKey)}${field("OxaPay Payout API key","oxapayPayoutKey","",true,settings.hasPayoutKey)}
${field("New admin password","newAdminPassword","",true)}
<button class="btn primary" onclick="saveSettings()">Save settings</button></div>`}
function field(label,key,val="",password=false,has=false){return `<div class="field"><label>${label}${has?" · configured":""}</label><input id="${key}" class="input" ${password?'type="password"':''} value="${esc(val)}" placeholder="${has?'Leave blank to keep current':''}"></div>`}
async function saveSettings(){const keys=["appName","channelUsername","channelJoinUrl","adminEntryUserId","referralCoins","referralDepositPercent","dailyCheckinCoins","giftBoxesPerReferral","giftMin","giftMax","giftDefaultBoxes","minDeposit","minWithdrawal","coinUsdRate","coinDailyPercent"];const b={};for(const k of keys)b[k]=$("#"+k).value;if($("#oxapayMerchantKey").value)b.oxapayMerchantKey=$("#oxapayMerchantKey").value;if($("#oxapayPayoutKey").value)b.oxapayPayoutKey=$("#oxapayPayoutKey").value;if($("#newAdminPassword").value)b.newAdminPassword=$("#newAdminPassword").value;await api("/api/admin/settings",{method:"PUT",body:b});toast("Saved");}
async function usersPage(){const q=prompt("Search Telegram ID or username (optional)","")||"";const r=await api("/api/admin/users?q="+encodeURIComponent(q));$("#adminContent").innerHTML=`<h2>Users</h2><div class="card">${r.users.map(u=>`<div class="history-row"><div><b>${esc(u.firstName||"User")}</b><div class="muted">@${esc(u.username||"")} · ${u.telegramId}</div></div><div><b>${Number(u.balance).toFixed(4)} USDT</b><br><button class="btn soft" onclick="adjust('${u.telegramId}')">Adjust</button></div></div>`).join("")||"<p class='muted'>No users.</p>"}</div>`}
async function adjust(id){const b=prompt("Add balance USDT (negative to subtract)","0");const c=prompt("Add coins (negative to subtract)","0");const g=prompt("Add gift boxes (negative to subtract)","0");await api("/api/admin/users/"+id,{method:"PATCH",body:{addBalance:Number(b||0),addCoins:Number(c||0),addGiftBoxes:Number(g||0)}});toast("Updated")}
async function tasksPage(){const ts=await api("/api/admin/tasks");$("#adminContent").innerHTML=`<h2>Tasks</h2><button class="btn primary" onclick="addTask()">+ Add task</button><div class="card section">${ts.map(t=>`<div class="task"><div><b>${esc(t.title)}</b><div class="muted">+${t.reward} · ${t.type} · ${t.active?"active":"off"}</div></div><button class="btn soft" onclick="deleteTask('${t._id}')">Delete</button></div>`).join("")}</div>`}
async function addTask(){const title=prompt("Title","Follow us");if(!title)return;const reward=Number(prompt("Reward coins","10"));const type=prompt("Type: channel/custom/daily","custom");const url=prompt("URL","");await api("/api/admin/tasks",{method:"POST",body:{title,reward,type,url,active:true}});tasksPage()}
async function deleteTask(id){if(!confirm("Delete task?"))return;await api("/api/admin/tasks/"+id,{method:"DELETE"});tasksPage()}
function renderLogin(){document.body.innerHTML=`<div class="gate" style="position:static;min-height:90vh"><div class="gate-card"><div class="logo-circle">⚙</div><h1>Admin Login</h1><input id="user" class="input" placeholder="Username" value="admin"><input id="pass" class="input" type="password" placeholder="Password"><button class="btn primary" onclick="login()">Login</button><p id="msg" class="muted"></p></div></div>`}
async function login(){try{await api("/api/admin/login",{method:"POST",body:{username:$("#user").value,password:$("#pass").value}});location.reload()}catch(e){$("#msg").textContent=e.message}}
async function api(url,o={}){const x={...o,headers:{"Content-Type":"application/json",...(o.headers||{})}};if(x.body&&typeof x.body!=="string")x.body=JSON.stringify(x.body);const r=await fetch(url,x);const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||"Request failed");return j}
function toast(s){const x=$("#toast");x.textContent=s;x.className="show";setTimeout(()=>x.className="",2200)}
function esc(v){return String(v??"").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[m]))}
window.login=login;window.saveSettings=saveSettings;window.adjust=adjust;window.addTask=addTask;window.deleteTask=deleteTask;
