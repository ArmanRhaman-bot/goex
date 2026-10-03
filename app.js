const tg = window.Telegram?.WebApp;
const $ = (s, root=document) => root.querySelector(s);
const $$ = (s, root=document) => [...root.querySelectorAll(s)];

const state = {
  page: "home",
  me: null,
  settings: null,
  tasks: [],
  membership: null,
  history: null,
  friends: [],
  online: 28,
  dark: localStorage.getItem("goex-theme") === "dark"
};

document.addEventListener("DOMContentLoaded", init);

async function init(){
  if(tg){
    tg.ready(); tg.expand();
    try { tg.setHeaderColor("#f2f7ff"); } catch {}
  }
  if(state.dark) document.body.classList.add("dark");

  $("#closeBtn").onclick = ()=> tg?.close();
  $("#moreBtn").onclick = ()=> showToast("Goex AI");
  $("#verifyJoin").onclick = verifyJoin;

  $$(".nav-item,.home-fab").forEach(b=>b.onclick=()=>navigate(b.dataset.page));
  $("#joinBtn").onclick = ()=> setTimeout(verifyJoin, 1000);

  if(!tg?.initData){
    hideLoading();
    showGate("Open this app from Telegram to continue.");
    $("#joinBtn").style.display="none";
    $("#verifyJoin").style.display="none";
    return;
  }

  try{
    const r=await api("/api/auth/telegram",{method:"POST",body:{
      initData:tg.initData,
      startParam:tg.initDataUnsafe?.start_param || ""
    }});
    state.me=r.user; state.membership=r.membership; state.adminEntry=r.adminEntry;
    state.online=28+Math.floor(Math.random()*6);
    $("#onlinePill").textContent=`● ${state.online} online`;
    if(!r.membership.joined){ showGate(); return; }
    await refresh();
    hideLoading(); $("#app").classList.remove("hidden"); render();
  }catch(e){
    hideLoading(); showGate(e.message||"Authentication failed");
  }
}

function hideLoading(){ $("#loading").classList.add("hidden"); }
function showGate(msg=""){
  $("#gate").classList.remove("hidden");
  $("#app").classList.add("hidden");
  $("#gateMsg").textContent=msg;
  $("#joinBtn").href=state.membership?.channel ? `https://t.me/${String(state.membership.channel).replace(/^@/,"")}` : "#";
}
async function verifyJoin(){
  try{
    const r=await api("/api/channel/check",{method:"POST"});
    state.membership=r;
    if(r.joined){ $("#gate").classList.add("hidden"); $("#app").classList.remove("hidden"); await refresh(); render(); }
    else $("#gateMsg").textContent="You are not a member yet. Join the channel and check again.";
  }catch(e){ $("#gateMsg").textContent=e.message; }
}

async function refresh(){
  const r=await api("/api/me");
  state.me=r.user; state.settings=r.settings; state.tasks=r.tasks; state.membership=r.membership;
  $("#appName").textContent=r.settings.appName||"Goex AI";
  if(!r.membership.joined){ showGate(); return; }
}

function navigate(page){
  state.page=page;
  render();
  window.scrollTo({top:0,behavior:"smooth"});
}

function render(){
  $$(".nav-item").forEach(x=>x.classList.toggle("active",x.dataset.page===state.page));
  if(state.page==="home") renderHome();
  if(state.page==="friends") renderFriends();
  if(state.page==="gifts") renderGifts();
  if(state.page==="account") renderAccount();
  if(state.page==="trade") renderTrade();
}

function avatar(){
  return state.me?.photoUrl ? `<img class="avatar" src="${esc(state.me.photoUrl)}">` : `<div class="avatar"></div>`;
}
function money(n){return Number(n||0).toFixed(4)}
function coins(n){return Number(n||0).toLocaleString(undefined,{maximumFractionDigits:2})}

function renderHome(){
  const u=state.me,s=state.settings;
  const estimated=(Number(u.coins||0)*Number(s.coinUsdRate||0.0001));
  const daily=estimated*(Number(s.coinDailyPercent||0.02)/100);
  $("#content").innerHTML=`
    <div class="hero-profile">${avatar()}<div><div class="name">${esc(u.firstName||"User")}</div><div class="sub">@${esc(u.username||"telegram")} · ID ${esc(u.telegramId)}</div><span class="level">Level 1</span></div></div>
    <div class="balance-hero"><div class="label">Total balance</div><div class="big-balance"><span class="coin-icon">₮</span> ${money(u.balance)} <span class="label">USDT</span></div></div>
    <div class="grid2">
      ${stat("🪙","Coins",coins(u.coins),`${s.coinDailyPercent}% per day`)}
      ${stat("₮","USDT balance",`$${money(u.balance)}`,`Frozen $0.00`)}
    </div>
    <div class="actions"><button class="btn primary" onclick="deposit()">↥ Top up</button><button class="btn primary" onclick="withdraw()">⇩ Withdraw</button></div>
    <div class="card invite-card"><h3>Get +${s.referralCoins} coins for an invite</h3><p>⚡ Plus ${s.referralDepositPercent}% of every deposit your friends make</p><p>You have invited ${u.invitedCount} friends</p></div>
    <div class="card section"><div class="row space"><div><b>Estimated income</b><div class="sub">$${daily.toFixed(6)}/day · $${(daily*30).toFixed(4)}/mo</div></div><b>$${estimated.toFixed(7)}</b></div></div>
    <div class="card section"><div class="section-head"><h3>Daily check-in</h3></div><button class="btn soft" onclick="checkin()">Claim +${s.dailyCheckinCoins} coins</button></div>
    <div class="card section"><div class="section-head"><h3>Tasks</h3><span class="sub">${state.tasks.length}</span></div>${taskList()}</div>`;
}
function stat(icon,title,value,foot){return `<div class="card stat"><span class="icon">${icon}</span><div class="label">${title}</div><div class="value">${value}</div><div class="sub">${foot}</div></div>`}

function taskList(){
  if(!state.tasks.length) return `<div class="muted">No tasks right now.</div>`;
  return state.tasks.slice(0,4).map(t=>`<div class="task"><div><b>${esc(t.title)}</b><div class="sub">+${t.reward} coins</div></div>${t.claimed?'<span class="chip">Claimed</span>':`<button class="btn soft" onclick="claimTask('${t._id}')">Claim</button>`}</div>`).join("");
}

async function checkin(){
  try{const r=await api("/api/checkin",{method:"POST"});showToast(r.ok?`+${r.reward} coins`:(r.message||"Already checked in"));await refresh();render();}catch(e){showToast(e.message)}
}
async function claimTask(id){
  try{const r=await api(`/api/tasks/${id}/claim`,{method:"POST"});showToast(`+${r.reward} coins`);await refresh();render();}catch(e){showToast(e.message)}
}

async function renderFriends(){
  $("#content").innerHTML=`<h1 class="page-title">Friends</h1><div class="card invite-card">
  <h3>Invite friends, earn together</h3><p>🪙 +${state.settings.referralCoins} coins when a friend opens the app</p><p>🪙 +${state.settings.referralDepositPercent}% of every deposit they make</p>
  <div class="refbox"><code id="refLink">${esc(state.me.referralLink)}</code><button class="copy" onclick="copyRef()">⧉</button></div>
  <button class="btn primary" onclick="shareInvite()">➤ Share invite</button></div>
  <div class="grid2 section">${stat("♧","Friends invited",state.me.invitedCount,"")} ${stat("🪙","Coins earned",state.me.referralCoins,"")}</div>
  <div class="section"><h3>Your friends</h3><div id="friendsList" class="card"><div class="muted">Loading…</div></div></div>`;
  try{
    const r=await api("/api/friends"); state.friends=r.friends;
    $("#friendsList").innerHTML=state.friends.length?state.friends.map(f=>`<div class="history-row"><span>${esc(f.firstName||"Friend")}<br><small class="muted">@${esc(f.username||"")}</small></span><small>${new Date(f.createdAt).toLocaleDateString()}</small></div>`).join(""):`<div class="muted">No friends yet. Share your link to get started.</div>`;
  }catch{}
}
function copyRef(){navigator.clipboard?.writeText(state.me.referralLink);showToast("Invite link copied")}
function shareInvite(){
  const text=encodeURIComponent(`Join ${state.settings.appName} and earn together`);
  const url=encodeURIComponent(state.me.referralLink);
  if(tg?.openTelegramLink) tg.openTelegramLink(`https://t.me/share/url?url=${url}&text=${text}`);
  else location.href=`https://t.me/share/url?url=${url}&text=${text}`;
}

function renderGifts(){
  const boxes=state.me.giftBoxes;
  $("#content").innerHTML=`<h1 class="page-title">Gift</h1>
  <div class="card center" style="padding:50px 22px">
    <div style="font-size:90px">🎁</div><div class="muted">You have</div><div style="font-size:35px;font-weight:800;margin:8px">+${boxes} boxes</div>
    ${boxes>0?`<button class="btn primary" onclick="openGift()">Open Gift · ${boxes} boxes left</button>`:`<button class="btn soft" disabled>No boxes left</button>`}
    <p class="muted">First gift is free. Invite friends to earn more gift boxes.</p>
  </div>`;
}
async function openGift(){
  try{const r=await api("/api/gifts/open",{method:"POST"});await refresh();renderGifts();openModal(`<div class="center"><div style="font-size:90px">🎁</div><div class="muted">You won</div><div style="font-size:42px;color:var(--green);font-weight:800">+${r.reward}</div><p>${r.boxesLeft} boxes left</p><button class="btn primary" onclick="closeModal()">Nice!</button></div>`);}catch(e){showToast(e.message)}
}

async function renderAccount(){
  const u=state.me;
  $("#content").innerHTML=`<div class="hero-profile">${avatar()}<div><div class="name">${esc(u.firstName||"User")}</div><div class="sub">@${esc(u.username||"telegram")} · ID ${esc(u.telegramId)}</div><span class="level">Level 1</span></div></div>
  <div class="balance-hero"><div class="label">Total balance</div><div class="big-balance">₮ ${money(u.balance)} <span class="label">USDT</span></div></div>
  <div class="grid2">
    ${stat("♧","Invited by",u.referredBy||"—","")}
    ${stat("🪙","Coin balance",coins(u.coins),"")}
    ${stat("₮","USDT balance",money(u.balance),"")}
    ${stat("♧","Referral income",`$${money(u.referralIncome)}`,"")}
    ${stat("🪙","Referral coins",coins(u.referralCoins),"")}
    ${stat("▣","USDT withdrawn",money(u.withdrawn),"")}
  </div>
  <div class="card section">
    <div class="setting-row"><div class="setting-left"><span class="setting-icon">◎</span>Language</div><span>English</span></div>
    <div class="setting-row" onclick="toggleTheme()"><div class="setting-left"><span class="setting-icon">${state.dark?"☾":"☼"}</span>Theme</div><span class="chip">${state.dark?"Dark":"Light"}</span></div>
    <div class="setting-row" onclick="showHistory()"><div class="setting-left"><span class="setting-icon">◔</span>Operations / History</div><span>⌄</span></div>
    <div class="setting-row" onclick="showTasks()"><div class="setting-left"><span class="setting-icon">?</span>FAQ / Tasks</div><span>⌄</span></div>
    ${state.adminEntry?`<div class="setting-row" onclick="location.href='/admin'"><div class="setting-left"><span class="setting-icon">⚙</span><b>Admin Panel</b></div><span>›</span></div>`:""}
    <div class="setting-row"><div class="setting-left"><span class="setting-icon">⚖</span>Legal — Terms & Privacy</div><span>›</span></div>
  </div>`;
}

function toggleTheme(){
  state.dark=!state.dark;document.body.classList.toggle("dark",state.dark);localStorage.setItem("goex-theme",state.dark?"dark":"light");renderAccount();
}
async function showHistory(){
  const r=await api("/api/history");
  const h=r.history.map(x=>`<div class="history-row"><span>${esc(x.title)}<br><small class="muted">${new Date(x.createdAt).toLocaleString()}</small></span><b class="${x.direction==="in"?"in":"out"}">${x.direction==="in"?"+":"-"}${x.amount} ${x.unit}</b></div>`).join("")||`<div class="muted">No history yet.</div>`;
  openModal(`<h2>Operations / History</h2><div class="tabs"><button class="tab active">History</button><button class="tab">Withdrawals</button></div>${h}`);
}
function showTasks(){openModal(`<h2>Tasks</h2>${taskList()}`)}

function renderTrade(){
  $("#content").innerHTML=`<h1 class="page-title">Trade</h1>
  <div class="card price-card"><div class="btc">₿</div><div style="flex:1"><div class="muted">BTC / USDT</div><div class="price" id="btcPrice">Loading…</div></div><span class="down" id="btcChange">—</span></div>
  <div class="tabs section"><button class="tab active">1h</button><button class="tab">4h</button><button class="tab">1D</button></div>
  <div class="chart-wrap"><canvas id="chart"></canvas></div>
  <div class="three"><div class="card mini-stat"><span class="muted">24h high</span><b id="high">—</b></div><div class="card mini-stat"><span class="muted">24h low</span><b id="low">—</b></div><div class="card mini-stat"><span class="muted">24h volume</span><b id="vol">—</b></div></div>
  <p class="muted center small">Market data from Binance. For information only, not financial advice.</p>`;
  loadMarket();
}
async function loadMarket(){
  try{
    const [ticker,klines]=await Promise.all([
      fetch("https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT").then(r=>r.json()),
      fetch("https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=45").then(r=>r.json())
    ]);
    $("#btcPrice").textContent=`$${Number(ticker.lastPrice).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}`;
    $("#btcChange").textContent=`${Number(ticker.priceChangePercent).toFixed(2)}%`;
    $("#high").textContent=`$${Number(ticker.highPrice).toLocaleString(undefined,{maximumFractionDigits:0})}`;
    $("#low").textContent=`$${Number(ticker.lowPrice).toLocaleString(undefined,{maximumFractionDigits:0})}`;
    $("#vol").textContent=`$${(Number(ticker.quoteVolume)/1e9).toFixed(2)}B`;
    drawChart(klines);
  }catch(e){$("#btcPrice").textContent="Unavailable";showToast("Market data unavailable")}
}
function drawChart(klines){
  const c=$("#chart"),ctx=c.getContext("2d"),dpr=devicePixelRatio||1;
  c.width=c.clientWidth*dpr;c.height=c.clientHeight*dpr;ctx.scale(dpr,dpr);
  const w=c.clientWidth,h=c.clientHeight;
  const vals=klines.map(k=>Number(k[4]));const lo=Math.min(...vals),hi=Math.max(...vals);
  ctx.clearRect(0,0,w,h);
  ctx.strokeStyle="#d9e4df";ctx.lineWidth=1;
  for(let i=1;i<6;i++){const y=(h*i/6);ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(w,y);ctx.stroke()}
  const xStep=w/(vals.length-1);
  ctx.beginPath();vals.forEach((v,i)=>{const x=i*xStep,y=h-((v-lo)/(hi-lo||1))*(h-20)-10;i?ctx.lineTo(x,y):ctx.moveTo(x,y)});ctx.strokeStyle="#008b59";ctx.lineWidth=3;ctx.stroke();
}

async function deposit(){
  openModal(`<h2>Top up USDT</h2><p class="muted">Create an OxaPay payment invoice.</p><label>Amount (USDT)</label><input id="depAmount" class="input" type="number" min="${state.settings.minDeposit||0.1}" step="0.01" value="1"><button class="btn primary" onclick="createDeposit()">Continue to payment</button>`);
}
async function createDeposit(){
  try{
    const amount=Number($("#depAmount").value);
    const r=await api("/api/deposit",{method:"POST",body:{amount}});
    closeModal();
    if(tg?.openLink) tg.openLink(r.payLink); else window.open(r.payLink,"_blank");
    showToast("Payment page opened");
    pollDeposit(r.trackId);
  }catch(e){showToast(e.message)}
}
async function pollDeposit(trackId){
  let tries=0;
  const timer=setInterval(async()=>{
    tries++;
    try{
      const r=await api(`/api/deposit/${encodeURIComponent(trackId)}`);
      if(["paid","complete"].includes(String(r.status||"").toLowerCase())){
        clearInterval(timer); await refresh(); render(); showToast("Deposit credited");
      }
    }catch{}
    if(tries>=60) clearInterval(timer);
  },5000);
}

async function withdraw(){
  openModal(`<h2>Withdraw USDT</h2><p class="muted">Minimum: ${state.settings.minWithdrawal} USDT</p>
  <label>Amount</label><input id="wdAmount" class="input" type="number" step="0.01" min="${state.settings.minWithdrawal}" value="${Math.max(state.settings.minWithdrawal,Math.min(state.me.balance,state.settings.minWithdrawal))}">
  <label>Network</label><select id="wdNetwork" class="input"><option value="TRC20">TRC20</option><option value="TON">TON</option><option value="BEP20">BEP20</option></select>
  <label>USDT address</label><input id="wdAddress" class="input" placeholder="Recipient address">
  <button class="btn primary" onclick="submitWithdraw()">Withdraw</button>`);
}
async function submitWithdraw(){
  try{
    const amount=Number($("#wdAmount").value),address=$("#wdAddress").value,network=$("#wdNetwork").value;
    if(!address) return showToast("Enter a wallet address");
    const r=await api("/api/withdraw",{method:"POST",body:{amount,address,currency:"USDT",network}});
    closeModal();await refresh();render();showToast(`Withdrawal ${r.status||"submitted"}`);
  }catch(e){showToast(e.message)}
}

function openModal(html){$("#modalBody").innerHTML=html;$("#modal").classList.remove("hidden")}
function closeModal(){$("#modal").classList.add("hidden")}
window.closeModal=closeModal;
$("#modal").addEventListener("click",e=>{if(e.target.id==="modal")closeModal()});

async function api(url,opts={}){
  const o={...opts,headers:{"Content-Type":"application/json",...(opts.headers||{})}};
  if(o.body && typeof o.body!=="string")o.body=JSON.stringify(o.body);
  const r=await fetch(url,o);const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.error||j.message||"Request failed");
  return j;
}
function showToast(msg){const x=$("#toast");x.textContent=msg;x.className="show";clearTimeout(showToast.t);showToast.t=setTimeout(()=>x.className="",2600)}
function esc(v){return String(v??"").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[m]))}
window.deposit=deposit;window.withdraw=withdraw;window.checkin=checkin;window.claimTask=claimTask;window.openGift=openGift;window.toggleTheme=toggleTheme;window.showHistory=showHistory;window.showTasks=showTasks;window.copyRef=copyRef;window.shareInvite=shareInvite;
