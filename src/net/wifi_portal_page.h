#pragma once
#include <pgmspace.h>
// Trang cấu hình Wi-Fi của thiết bị OALPHA: xem kết nối hiện tại, quét mạng
// xung quanh, nhập mật khẩu, quản lý mạng đã lưu, nhập tay mạng ẩn, bật/tắt
// Wi-Fi cấu hình (AP). Firmware phục vụ trang này tại GET /wifi, và tại GET /
// khi điện thoại nối vào Wi-Fi do thiết bị phát (captive portal: điện thoại tự
// bật trang này khi nối AP).
//
// Vì sao nhúng PROGMEM: trang nằm sẵn trong flash cùng firmware nên luôn chạy
// được kể cả khi chưa nạp LittleFS (pio run -t uploadfs). Trang tự chứa hoàn
// toàn (CSS + JS nội tuyến, không font/CDN/ảnh ngoài) vì lúc ở AP không có
// internet. JS viết kiểu ES2017 (không dùng ?. và ??) cho webview captive cũ.
//
// Hợp đồng API Wi-Fi v2: GET /api/wifi/state, /api/wifi/scan[?fresh=1],
// /api/wifi/list; POST /api/wifi/add, /remove, /connect, /portal gửi form
// x-www-form-urlencoded KÈM header "X-OALPHA: 1" (chặn CSRF: trang lạ không gửi
// được header tùy biến khi chưa qua preflight; thiếu header -> 403).
// add/remove trả 500 = không có gì thay đổi, báo như lỗi thường.
// Theo dõi kết quả: ghi attempt.id (mốc) trước khi gửi, sau đó hỏi state mỗi
// 1 s (tối đa ~40 s, sau đó 4 s) tới khi có attempt id > mốc, đúng SSID,
// user === true và khác "trying" (lượt nền cùng SSID bị hủy không bị nhận nhầm).
// Lỡ mất kết quả (vd. đổi mật khẩu qua LAN: thiết bị rời mạng suốt lượt thử)
// thì suy từ lượt kế tiếp. attempt.rolledBack = mật khẩu mới hỏng, thiết bị đã
// giữ lại mật khẩu cũ. state.paused = đang tạm dừng tự nối lại.
// Lúc bình thường hỏi mỗi 4 s. Mất liên lạc khi đang thử là bình thường (thiết
// bị đổi kênh làm điện thoại rớt khỏi AP) nên chỉ nhắc nhẹ và hỏi tiếp.
//
// BẢO MẬT: SSID là dữ liệu không tin cậy (điểm phát lạ có thể đặt tên chứa
// HTML/JS) nên chỉ được đưa vào DOM qua textContent / createTextNode, sự kiện
// gắn bằng addEventListener; không dùng innerHTML hay thuộc tính onclick.
// Chỉ include file này ở MỘT file .cpp (mảng static sẽ bị nhân bản mỗi lần include).
static const char WIFI_PORTAL_HTML[] PROGMEM = R"WIFIPAGE(<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Cài đặt Wi-Fi · OALPHA</title>
<style>
:root{--bg:#f3f5fb;--ln:#eef1f7;--fg:#16213c;--dim:#5a6681;--navy:#1f3f87;--gold:#e3a21a;--ok:#17a673;--okI:#0b6e4b;--okS:#e4f6ee;--warn:#e8930c;--warnI:#8a5a00;--warnS:#fdf2df;--bad:#e23d4b;--badI:#b4232f;--badS:#fdeaec;--soft:#e8edf9}
*{box-sizing:border-box}[hidden]{display:none!important}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 "Segoe UI",system-ui,-apple-system,Roboto,Arial,sans-serif;-webkit-text-size-adjust:100%}
header{background:#1f3f87;background:linear-gradient(135deg,#2a4ba0,#16306e);color:#fff;border-bottom:3px solid var(--gold)}
.in{max-width:560px;margin:0 auto;padding:16px 12px}
header .in{display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between}
.br{font-size:12px;font-weight:800;letter-spacing:.2em;color:#f6cf5a}
h1{margin:2px 0 0;font-size:20px;line-height:1.25}
.pill{display:inline-flex;align-items:center;gap:7px;background:#fff;color:var(--fg);border-radius:99px;padding:5px 12px;font-size:13px;font-weight:700}
.pill i{width:9px;height:9px;border-radius:50%;background:var(--dim)}
.ok>i{background:var(--ok)}.warn>i{background:var(--warn)}.ap>i{background:var(--gold)}.bad>i{background:var(--bad)}
.card{background:#fff;border:1px solid #e2e7f1;border-radius:16px;padding:16px;margin-bottom:14px;box-shadow:0 1px 2px rgba(16,33,72,.06),0 8px 24px rgba(16,33,72,.07)}
h2{margin:0 0 10px;font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:var(--navy)}
.hd{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:6px}.hd h2{margin:0}
.cur{display:flex;align-items:center;gap:12px}.cur .bars{width:34px;height:28px}
.big{font-size:18px;font-weight:700;word-break:break-all}
.sub{color:var(--dim);font-size:13px;margin:0}
dl{margin:10px 0 0}dl div{display:flex;justify-content:space-between;gap:12px;padding:7px 0;border-top:1px solid var(--ln)}
dt{color:var(--dim)}dd{margin:0;font-weight:600;text-align:right;word-break:break-all}
.apb{margin-top:12px;background:var(--warnS);border:1px solid #f0d49c;border-radius:12px;padding:12px;color:#4f3300}
.apb dl div{border-color:#f0d49c}.apb dt,.apb .sub{color:#6b4a00}
.pz{margin-top:10px;padding-left:9px;border-left:3px solid var(--gold)}
.res{border:1px solid #c9d4ee;border-left-width:5px;border-radius:14px;padding:12px 14px;margin-bottom:14px;background:var(--soft)}
.res.ok{background:var(--okS);border-color:var(--ok);color:#0a3d2a}
.res.warn{background:var(--warnS);border-color:var(--warn);color:#4f3300}
.res.bad{background:var(--badS);border-color:var(--bad);color:#6d1119}
.res p{margin:6px 0 0;font-size:14px}.res a{color:inherit;font-weight:700;word-break:break-all}.res .acts{margin-top:10px}
.spin{display:inline-block;width:16px;height:16px;border:3px solid #b9c5e3;border-top-color:var(--navy);border-radius:50%;vertical-align:-3px;margin-right:8px;animation:sp 1s linear infinite}
@keyframes sp{to{transform:rotate(360deg)}}
ul{list-style:none;margin:0;padding:0}
.net{display:flex;align-items:center;gap:10px;width:100%;min-height:48px;padding:8px 6px;background:none;border:0;border-bottom:1px solid var(--ln);color:var(--fg);font:inherit;text-align:left;cursor:pointer}
.net:hover,.net[aria-expanded=true]{background:var(--soft)}
.nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
.nm,.q{unicode-bidi:-webkit-isolate;unicode-bidi:isolate}
.bars{width:22px;height:18px;flex:none}.bars rect{fill:#d3d9e6}.bars .on{fill:var(--ok)}.b2 .on{fill:var(--warn)}.b1 .on{fill:var(--bad)}
.lk{width:14px;height:14px;fill:var(--dim);flex:none}
.tag{flex:none;font-size:12px;font-weight:700;padding:3px 9px;border-radius:99px;background:var(--soft);color:var(--navy)}
.tag.ok{background:var(--okS);color:var(--okI)}.tag.warn{background:var(--warnS);color:var(--warnI)}.tag.bad{background:var(--badS);color:var(--badI)}
.sv{display:flex;flex-wrap:wrap;align-items:center;gap:8px 10px;padding:10px 0;border-bottom:1px solid var(--ln)}.sv .nm{flex:1 1 8em}.sv .acts{margin-left:auto}
#cBars:empty{display:none}
.empty{color:var(--dim);padding:6px 0}
.acts{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.btn{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0 18px;border-radius:12px;border:1px solid var(--navy);background:var(--navy);color:#fff;font:inherit;font-weight:700;cursor:pointer;text-decoration:none}
.btn.gh{background:#fff;color:var(--navy);border-color:#b7c3e0}
.btn.gh:hover,.eye[aria-pressed=true]{background:var(--soft)}
.btn.sm{min-height:40px;padding:0 14px;font-size:14px}.btn:disabled{opacity:.6;cursor:default}
.lnk{background:none;border:0;min-height:44px;padding:0 6px;color:var(--navy);font:inherit;font-weight:600;text-decoration:underline;cursor:pointer}
.pf{padding:6px 6px 14px;border-bottom:1px solid var(--ln)}form .acts{margin-top:12px}
label{display:block;font-weight:600;font-size:14px;margin:10px 0 6px}
input{width:100%;min-height:46px;font:inherit;font-size:16px;padding:10px 12px;border:1px solid #8792a8;border-radius:12px;background:#fff;color:var(--fg)}
.pw{display:flex;gap:8px}.pw input{flex:1;min-width:0}
.err{color:var(--badI);font-weight:600;font-size:14px;margin:8px 0 0}
summary{cursor:pointer;font-weight:700;color:var(--navy);padding:10px 0}
footer{text-align:center;padding:0 12px 28px;color:var(--dim);font-size:13px}footer .acts{justify-content:center}
:focus-visible{outline:3px solid var(--navy);outline-offset:2px}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style>
</head>
<body>
<header><div class="in">
<div><div class="br">OALPHA</div><h1>Cài đặt Wi-Fi cho thiết bị</h1></div>
<span id="pill" class="pill"><i aria-hidden="true"></i><span id="pillT">Đang tải…</span></span>
</div></header>
<main class="in">
<section class="card" aria-labelledby="hA">
<h2 id="hA">Kết nối hiện tại</h2>
<div class="cur"><span id="cBars"></span><div><div id="cName" class="big">—</div><p id="cSig" class="sub">—</p></div></div>
<dl><div><dt>Địa chỉ IP</dt><dd id="cIp">—</dd></div><div><dt>Kênh</dt><dd id="cCh">—</dd></div></dl>
<p id="cPause" class="sub pz" hidden>Thiết bị tạm dừng tự nối lại trong lúc bạn dùng trang này.</p>
<div id="apBox" class="apb" hidden>
<b>Wi-Fi cấu hình đang bật</b><p id="apWhy" class="sub"></p>
<dl><div><dt>Tên Wi-Fi</dt><dd id="apName">—</dd></div><div><dt>Địa chỉ trang</dt><dd id="apIp">192.168.4.1</dd></div><div><dt>Máy đang nối</dt><dd id="apCli">0</dd></div><div id="apLr" hidden><dt>Tự tắt sau</dt><dd id="apLeft"></dd></div></dl>
</div>
</section>
<div id="res" role="status" aria-live="polite"></div>
<section class="card" aria-labelledby="hB">
<div class="hd"><h2 id="hB">Mạng xung quanh</h2><button id="scanBtn" type="button" class="btn gh sm">Quét lại</button></div>
<p id="scanMsg" class="sub">Đang quét…</p>
<ul id="nets"></ul>
</section>
<section class="card" aria-labelledby="hC">
<h2 id="hC">Mạng đã lưu (<span id="savedN">0</span>/<span id="savedMax">?</span>)</h2>
<ul id="saved"><li class="empty">Đang tải…</li></ul>
</section>
<details id="man" class="card">
<summary>Mạng ẩn / nhập tay</summary>
<form id="mf" novalidate>
<label for="mS">Tên Wi-Fi (SSID)</label>
<input id="mS" maxlength="32" autocapitalize="none" autocorrect="off" spellcheck="false" autocomplete="off" aria-describedby="mErr">
<label for="mP">Mật khẩu <span class="sub">(để trống nếu là mạng mở)</span></label>
<div class="pw"><input id="mP" type="password" maxlength="64" autocapitalize="none" autocorrect="off" spellcheck="false" autocomplete="off" aria-describedby="mErr"><button type="button" class="btn gh eye" aria-controls="mP" aria-pressed="false" aria-label="Hiện mật khẩu">Hiện</button></div>
<p id="mErr" class="err" role="alert" hidden></p>
<div class="acts"><button id="mGo" class="btn">Lưu &amp; kết nối</button></div>
</form>
</details>
</main>
<form id="pf" class="pf" novalidate hidden>
<p id="pfNote" class="sub"></p>
<div id="pfPw"><label for="pfPass">Mật khẩu</label>
<div class="pw"><input id="pfPass" type="password" maxlength="64" autocapitalize="none" autocorrect="off" spellcheck="false" autocomplete="off" aria-describedby="pfNote pfErr"><button type="button" class="btn gh eye" aria-controls="pfPass" aria-pressed="false" aria-label="Hiện mật khẩu">Hiện</button></div></div>
<p id="pfErr" class="err" role="alert" hidden></p>
<div class="acts"><button id="pfGo" class="btn">Kết nối</button><button id="pfChg" type="button" class="lnk">Đổi mật khẩu</button><button id="pfX" type="button" class="btn gh sm">Hủy</button></div>
</form>
<footer>
<div class="acts"><button id="pBtn" type="button" class="btn gh">Bật Wi-Fi cấu hình</button><a class="btn gh" href="/index.html">Trang giám sát đầy đủ</a></div>
<p>ESP32 chỉ dùng Wi-Fi 2,4 GHz</p>
</footer>
<script>
(function(){
'use strict';
var $=function(i){return document.getElementById(i)},NS='http://www.w3.org/2000/svg',
S=null,NETS=[],SAVED=[],T=null,FM=null,F=$('pf'),R=$('res'),resKey='',
PP=$('pfPass'),PW=$('pfPw'),PG=$('pfGo'),PC=$('pfChg'),PN=$('pfNote'),PE=$('pfErr'),n0=0,seq=0,pollT=0,scanT=0,scanN=0,auto=1,dirty=0,apEnd=0,lost=0,first=1,curK='',
SIG=['Rất yếu','Yếu','Trung bình','Mạnh','Rất mạnh'],
LAST={ok:['Đã kết nối','ok'],wrong_pass:['Sai mật khẩu','bad'],not_found:['Không thấy mạng','warn'],timeout:['Lỗi','bad'],fail:['Lỗi','bad'],trying:['Đang thử…','warn']},
CHG='Thiết bị sẽ nối lại bằng mật khẩu mới để kiểm tra (mất mạng vài giây); sai thì tự giữ mật khẩu cũ.';
function h(t,a,c){var e=document.createElement(t),k,v;for(k in a||{}){v=a[k];if(v==null)continue;
if(k==='cls')e.className=v;else if(k==='txt')e.textContent=v;else if(k.slice(0,2)==='on')e.addEventListener(k.slice(2),v);else e.setAttribute(k,v)}
add(e,c);return e}
function add(e,c){for(var i=0;c&&i<c.length;i++)if(c[i]!=null&&c[i]!=='')e.appendChild(typeof c[i]==='string'?document.createTextNode(c[i]):c[i])}
function qs(s){return h('span',{cls:'q',txt:'“'+s+'”'})}
function link(u){return h('a',{href:u,txt:u})}
function sv(t,a){var e=document.createElementNS(NS,t);for(var k in a)e.setAttribute(k,a[k]);return e}
function bars(n,r){var s=sv('svg',{viewBox:'0 0 20 16','class':'bars b'+n,role:'img','aria-label':'Sóng '+SIG[n].toLowerCase()+(r?', '+r+' dBm':'')});
for(var i=0;i<4;i++)s.appendChild(sv('rect',{x:i*5+1,y:12-i*4,width:3,height:4+i*4,rx:1,'class':i<n?'on':''}));return s}
function lock(){var s=sv('svg',{viewBox:'0 0 16 16','class':'lk',role:'img','aria-label':'Có mật khẩu'});
s.appendChild(sv('path',{'fill-rule':'evenodd',d:'M5 7V5a3 3 0 0 1 6 0v2h2v8H3V7zm1.5 0h3V5a1.5 1.5 0 0 0-3 0z'}));return s}
function nb(o){var b=o.bars,r=o.rssi;if(typeof b==='number')return b<0?0:b>4?4:b|0;return !r?0:r>=-55?4:r>=-65?3:r>=-75?2:r>=-85?1:0}
function ago(s){return s<60?s+' giây':s<3600?Math.round(s/60)+' phút':Math.round(s/3600)+' giờ'}
function isCur(s){return !!(S&&S.up&&S.ssid===s)}
function svd(s){for(var i=0;i<SAVED.length;i++)if(SAVED[i].ssid===s)return SAVED[i];return null}
async function req(u,o,ms){o=o||{};o.cache='no-store';var c=window.AbortController?new AbortController():null,t=0;
if(c){o.signal=c.signal;t=setTimeout(function(){c.abort()},ms||6000)}
try{var r=await fetch(u,o),x=await r.text(),j=null;try{j=JSON.parse(x)}catch(e){}return{ok:r.ok,st:r.status,j:j}}
finally{clearTimeout(t)}}
function post(u,d){var b=[];for(var k in d)b.push(encodeURIComponent(k)+'='+encodeURIComponent(d[k]));
return req(u,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','X-OALPHA':'1'},body:b.join('&')})}
function errOf(r){return r.j&&r.j.err?r.j.err:r.st===401?'Cần đăng nhập: tải lại trang và nhập tài khoản web của thiết bị.':r.st===403?'Thiết bị từ chối yêu cầu. Hãy tải lại trang rồi thử lại.':r.st===507?'Danh sách đã đầy, hãy xóa bớt một mạng đã lưu.':'Thiết bị báo lỗi '+r.st+'.'}
function u8(s){try{return new TextEncoder().encode(s).length}catch(e){try{return unescape(encodeURIComponent(s)).length}catch(x){return 99}}}
function badSsid(s){return !s?'Hãy nhập tên Wi-Fi.':u8(s)>32?'Tên Wi-Fi dài quá 32 byte (chữ có dấu tốn 2–3 byte).':''}
function badPass(p,open){if(!p)return open?'':'Mạng này cần mật khẩu.';var n=u8(p);
return n>=8&&n<=63||/^[0-9a-fA-F]{64}$/.test(p)?'':'Mật khẩu Wi-Fi phải dài 8–63 ký tự, hoặc đúng 64 ký tự hex.'}
function box(c,k,kids){if(k===resKey)return;resKey=k;R.textContent='';var d=h('div',{cls:'res '+c});add(d,kids);R.appendChild(d)}
function ferr(el,m,f){if(!el){if(m)box('bad','e'+(++n0),[m]);return}el.textContent=m;el.hidden=!m;if(m&&f)f.focus()}
function pill(c,t){$('pill').className='pill '+c;$('pillT').textContent=t}
function left(){var s=apEnd?Math.max(0,Math.round((apEnd-Date.now())/1000)):0;$('apLr').hidden=!s;$('apLeft').textContent=Math.floor(s/60)+':'+('0'+s%60).slice(-2)}

function paint(){var s=S,up=!!s.up,n=nb(s),cb=$('cBars');
if(s.phase==='connecting'||s.trying)pill('warn','Đang kết nối…');else if(up)pill('ok','Đã kết nối');else if(s.portal)pill('ap','Đang phát Wi-Fi cấu hình');else pill('bad','Chưa có mạng');
$('cName').textContent=up?s.ssid:s.trying?'Đang thử “'+s.trying+'”…':'Chưa kết nối mạng nào';
cb.textContent='';if(up)cb.appendChild(bars(n,s.rssi));
$('cSig').textContent=up?s.rssi+' dBm · Sóng '+SIG[n].toLowerCase():s.trying?'':'Chọn một mạng ở mục “Mạng xung quanh” bên dưới.';
$('cIp').textContent=up&&s.ip?s.ip:'—';
$('cCh').textContent=up&&s.channel?s.channel:'—';
$('cPause').hidden=s.paused!==true;
$('apBox').hidden=!s.portal;apEnd=0;
if(s.portal){$('apName').textContent=s.ap||'—';$('apIp').textContent=s.apIp||'192.168.4.1';$('apCli').textContent=(s.apClients|0)+' máy';
$('apWhy').textContent=s.portalReason==='auto'?'Tự bật vì chưa nối được mạng đã lưu nào.':s.portalReason==='manual'?'Đã bật bằng tay.':'';
if(s.closesIn>0)apEnd=Date.now()+s.closesIn*1000}
left();
$('pBtn').textContent=s.portal?'Tắt Wi-Fi cấu hình':'Bật Wi-Fi cấu hình';
if(s.max)$('savedMax').textContent=s.max;
var k=up+'|'+s.ssid+'|'+s.saved;if(curK&&k!==curK)loadSaved();curK=k;
if(first){first=0;var a=s.attempt;
if(a&&!T){if(a.result!=='trying'){if(a.ago<120)result(a,1)}
else if(a.user===true){T={ssid:a.ssid,base:a.id-1,uid:a.id,t0:Date.now()-(a.ago|0)*1000};showTry()}}}}
function kick(ms){clearTimeout(pollT);pollT=setTimeout(poll,ms)}
async function poll(){clearTimeout(pollT);var my=++seq,ok=0,r=null;
try{r=await req('/api/wifi/state')}catch(e){}
if(my!==seq)return;
try{if(r&&r.ok&&r.j){S=r.j;ok=1;lost=0;paint()}
else{if(r&&r.st===401)box('bad','auth',[errOf(r)]);if(++lost>1&&!T)pill('','Mất liên lạc với thiết bị')}
if(T)await track(ok)}
finally{if(my===seq)kick(T&&!T.slow?1000:4000)}}

function startTrack(ssid,base,lostNow,chg){T={ssid:ssid,base:base,t0:Date.now(),lost:lostNow,chg:!!chg};showTry();kick(1000)}
async function track(ok){var t=T,a=S&&S.attempt,el=(Date.now()-t.t0)/1000,x=null;
if(ok&&a&&a.id>t.base){
if(a.ssid===t.ssid&&a.user===true){if(a.result!=='trying'){T=null;return done(a,t)}t.uid=a.id}
else if(a.ssid!==t.ssid)x=await lastOf(t.ssid,el);
else if(a.result!=='trying'&&(t.uid||el-(a.ago|0)>=2))x={id:a.id,ssid:a.ssid,result:a.result,reason:a.reason,text:a.text,rolledBack:a.rolledBack,miss:1};
if(x&&T===t){T=null;return done(x,t)}}
if(T!==t)return;
t.lost=!ok;if(el>40)t.slow=1;
if(el>180){T=null;return box('warn','gone'+t.t0,[h('b',null,['Không nhận được kết quả kết nối ',qs(t.ssid),'.']),h('p',{txt:'Hãy tải lại trang để xem trạng thái mới nhất.'})])}
showTry()}
async function lastOf(ssid,el){try{var r=await req('/api/wifi/list');if(r.ok&&Array.isArray(r.j)){SAVED=r.j;var s=svd(ssid);
if(s&&s.last&&s.last!=='trying'&&s.lastAgo>=0&&s.lastAgo<=el+1)return{id:'l'+(++n0),ssid:ssid,result:s.last}}}catch(e){}return null}
function showTry(){var t=T,el=Math.max(0,Math.round((Date.now()-t.t0)/1000)),ap=S&&S.portal&&S.ap?S.ap:'',
note=ap?'Điện thoại có thể bị ngắt khỏi Wi-Fi “'+ap+'” vài giây khi thiết bị đổi kênh — nếu vậy hãy nối lại để xem kết quả.':t.lost?'Tạm mất liên lạc với thiết bị trong lúc đổi mạng, đang thử lại…':'';
if(t.slow)box('warn','slow'+t.t0+(t.lost?1:0),[h('b',null,['Chưa nhận được kết quả kết nối ',qs(t.ssid),'.']),
h('p',{txt:!t.lost?'Thiết bị vẫn đang thử, trang tiếp tục theo dõi.':ap?'Nếu điện thoại đã rời Wi-Fi “'+ap+'”, hãy nối lại rồi tải lại trang này.':'Kiểm tra điện thoại còn chung mạng với thiết bị rồi tải lại trang.'})]);
else box('info','try'+t.t0+(t.lost?1:0)+ap,[h('span',{cls:'spin','aria-hidden':'true'}),h('b',null,[t.chg?'Đang kiểm tra mật khẩu mới của ':'Đang thử kết nối ',qs(t.ssid),'…']),' ',h('span',{id:'tc','aria-hidden':'true'}),note?h('p',{txt:note}):null]);
var c=$('tc');if(c)c.textContent=el+' giây'}
function done(a,t){result(a,0,t);loadSaved()}
function result(a,quiet,t){var x=a.ssid,k='r'+a.id+a.result,p,ip=S&&S.ip,hn=S&&S.hostname,chg=t&&t.chg,wp=a.result==='wrong_pass';
if(a.rolledBack===true){box('warn',k,[h('b',{txt:wp?'Mật khẩu mới không đúng — thiết bị vẫn dùng mật khẩu cũ.':'Chưa đổi được mật khẩu — thiết bị vẫn dùng mật khẩu cũ.'}),
h('p',null,['Wi-Fi ',qs(x),': ',wp?'hãy nhập lại mật khẩu mới, hoặc bỏ qua nếu không cần đổi.':a.text||''])]);if(wp&&!quiet)reopen(x)}
else if(a.result==='ok'){p=h('p');
if(a.miss&&chg)add(p,['Trang không kịp nhận kết quả thử mật khẩu mới. Nếu mật khẩu mới sai, thiết bị đã tự giữ mật khẩu cũ.']);
else if(ip&&/^[0-9.]+$/.test(ip)){add(p,['Địa chỉ mới: ',link('http://'+ip+'/')]);if(hn&&/^[A-Za-z0-9-]+$/.test(hn))add(p,[' hoặc ',link('http://'+hn+'.local/')]);add(p,['. Hãy nối điện thoại về Wi-Fi ',qs(x),' rồi mở địa chỉ trên.'])}
else add(p,['Hãy nối điện thoại về Wi-Fi ',qs(x),' rồi mở lại trang của thiết bị.']);
box('ok',k,[h('b',null,a.miss&&chg?['Thiết bị đã nối lại ',qs(x),'.']:chg?['Đã đổi mật khẩu ',qs(x),', thiết bị đã nối lại bằng mật khẩu mới.']:['Đã kết nối ',qs(x),'.']),p,S&&S.portal?h('div',{cls:'acts'},[h('button',{type:'button',cls:'btn',txt:'Tắt Wi-Fi cấu hình ngay',onclick:function(){setPortal(false)}})]):null])}
else if(wp){box('bad',k,[h('b',null,['Sai mật khẩu Wi-Fi ',qs(x),'.']),h('p',{txt:'Hãy nhập lại mật khẩu. Nếu chắc đúng mật khẩu, đặt thiết bị gần router hơn rồi thử lại.'})]);if(!quiet)reopen(x)}
else if(a.result==='not_found')box('warn',k,[h('b',null,['Không thấy mạng ',qs(x),'.']),h('p',{txt:'ESP32 chỉ bắt được Wi-Fi 2,4 GHz: nếu router chỉ phát 5 GHz, hãy bật thêm băng 2,4 GHz, hoặc đặt thiết bị gần router hơn.'})]);
else box('bad',k,[h('b',null,['Không kết nối được ',qs(x),'.']),h('p',{txt:(a.text||(a.result==='timeout'?'Router không trả lời kịp.':'Lỗi không xác định.'))+(a.reason?' (mã '+a.reason+')':'')})])}
function reopen(ssid){var ls=$('nets').children;
for(var i=0;i<ls.length;i++)if(ls[i]._n&&ls[i]._n.ssid===ssid)return openForm(ls[i]._n,ls[i],1);
$('man').open=true;$('mS').value=ssid;$('mP').value='';$('mP').focus()}

async function scan(fresh){clearTimeout(scanT);var b=$('scanBtn'),m=$('scanMsg');b.disabled=true;
if(fresh||!NETS.length)m.textContent='Đang quét mạng xung quanh…';
try{var r=await req('/api/wifi/scan'+(fresh?'?fresh=1':''));if(!r.ok||!r.j)throw r;var j=r.j;
NETS=(j.nets||[]).filter(function(n){return n&&n.ssid});renderNets();
if(j.scanning&&++scanN<30){m.textContent='Đang quét mạng xung quanh…';scanT=setTimeout(function(){scan(false)},1200);return}
if(auto&&!fresh&&j.age>60){auto=0;scanN=0;return scan(true)}
auto=0;scanN=0;
m.textContent=NETS.length?(j.age>0?'Cập nhật '+ago(j.age)+' trước. ':'')+'Chạm vào một mạng để kết nối.':'Không thấy mạng nào. Bấm “Quét lại” để thử lại.'}
catch(e){if(scanN>0&&++scanN<30){scanT=setTimeout(function(){scan(false)},1500);return}
scanN=0;m.textContent='Không quét được'+(e&&e.st?': '+errOf(e):'')+'. Bấm “Quét lại” để thử lại.'}
b.disabled=false}
function renderNets(force){if(FM&&!force){dirty=1;return}dirty=0;var ul=$('nets'),hit=0;ul.textContent='';
NETS.forEach(function(n){var li=h('li');li._n=n;
li.appendChild(h('button',{type:'button',cls:'net','aria-expanded':'false','aria-controls':'pf',onclick:function(){openForm(n,li)}},
[bars(nb(n),n.rssi),h('span',{cls:'nm',txt:n.ssid}),n.enc?lock():h('span',{cls:'sr',txt:'Mạng mở'}),
isCur(n.ssid)?h('span',{cls:'tag ok',txt:'Đang dùng'}):n.saved||svd(n.ssid)?h('span',{cls:'tag',txt:'Đã lưu'}):null]));
if(FM&&FM.ssid===n.ssid){li.appendChild(F);hit=1}
ul.appendChild(li)});
if(FM&&!hit){F.hidden=true;FM=null}
expanded()}
function expanded(){var bs=$('nets').getElementsByTagName('button');
for(var i=0;i<bs.length;i++)if(bs[i].className==='net')bs[i].setAttribute('aria-expanded',FM&&!F.hidden&&bs[i].parentNode._n.ssid===FM.ssid?'true':'false')}

function openForm(n,li,chg){if(!chg&&FM&&FM.ssid===n.ssid&&!F.hidden)return closeForm();
var sd=svd(n.ssid);
FM={ssid:n.ssid,enc:!!n.enc,cur:isCur(n.ssid),mode:chg?'chg':(n.saved||sd)&&!(n.enc&&sd&&sd.open)?'saved':'new'};
li.appendChild(F);F.hidden=false;PP.value='';PP.type='password';F.querySelector('.eye').setAttribute('aria-pressed','false');ferr(PE,'');mode();expanded();
if(!PW.hidden)PP.focus();else if(!PG.hidden)PG.focus()}
function mode(){var m=FM,saved=m.mode==='saved',chg=m.mode==='chg';
PW.hidden=!(m.enc&&!saved);PC.hidden=!(saved&&m.enc);PG.hidden=m.cur&&saved;
PG.textContent=chg?(m.cur?'Đổi mật khẩu & nối lại':'Đổi mật khẩu & kết nối'):'Kết nối';
PN.textContent=chg?(m.cur?CHG:'Thiết bị sẽ thử nối mạng này bằng mật khẩu mới; sai thì tự giữ mật khẩu cũ.'):m.cur&&saved?'Thiết bị đang dùng mạng này.':saved?'Mạng đã lưu: kết nối bằng mật khẩu đã lưu.':m.enc?'':'Mạng mở, không cần mật khẩu.'}
function chgOk(s){return confirm('Đổi mật khẩu Wi-Fi “'+s+'”?\n\n'+CHG)}
function closeForm(){var s=FM&&FM.ssid,ls=$('nets').children;F.hidden=true;FM=null;if(dirty)renderNets();else expanded();
for(var i=0;i<ls.length;i++)if(ls[i]._n&&ls[i]._n.ssid===s)ls[i].firstChild.focus()}
async function act(u,d,ssid,er,btn,chg){var x=badSsid(ssid);if(x){ferr(er,x);return 0}ferr(er,'');if(btn)btn.disabled=true;
try{var s=await req('/api/wifi/state',0,2500);if(s.ok&&s.j){S=s.j;paint()}}catch(e){}
var base=S&&S.attempt?S.attempt.id|0:0;
try{var r=await post(u,d);
if(!r.ok){ferr(er,r.st===404?'Thiết bị không còn lưu mạng này.':errOf(r));return 0}
if(FM&&FM.ssid===ssid)closeForm();
loadSaved();
if(r.j&&r.j.connecting===false)box('ok','sv'+(++n0),[h('b',null,['Đã lưu ',qs(ssid),'.'])]);else startTrack(ssid,base,0,chg);
return 1}
catch(e){if(FM&&FM.ssid===ssid)closeForm();startTrack(ssid,base,1,chg);return 1}
finally{if(btn)btn.disabled=false}}
F.addEventListener('submit',function(e){e.preventDefault();var m=FM;if(!m)return;
if(m.mode==='saved')return act('/api/wifi/connect',{ssid:m.ssid},m.ssid,PE,PG);
var p=m.enc?PP.value:'',x=badPass(p,!m.enc);if(x)return ferr(PE,x,PP);
if(m.mode==='chg'&&(m.cur||isCur(m.ssid))&&!chgOk(m.ssid))return;
act('/api/wifi/add',{ssid:m.ssid,pass:p,connect:1},m.ssid,PE,PG,!!svd(m.ssid))});
PC.addEventListener('click',function(){FM.mode='chg';mode();PP.focus()});
$('pfX').addEventListener('click',closeForm);
$('mf').addEventListener('submit',async function(e){e.preventDefault();var s=$('mS').value.trim(),p=$('mP').value,er=$('mErr'),x=badSsid(s);
if(x)return ferr(er,x,$('mS'));x=badPass(p,1);if(x)return ferr(er,x,$('mP'));
if(isCur(s)&&!chgOk(s))return;
if(await act('/api/wifi/add',{ssid:s,pass:p,connect:1},s,er,$('mGo'),!!svd(s)))$('mP').value=''});

async function loadSaved(){try{var r=await req('/api/wifi/list');if(r.ok&&Array.isArray(r.j)){SAVED=r.j;renderSaved();renderNets()}}catch(e){}}
function renderSaved(){var ul=$('saved');ul.textContent='';$('savedN').textContent=SAVED.length;
if(!SAVED.length)return ul.appendChild(h('li',{cls:'empty',txt:'Chưa lưu mạng nào. Chọn một mạng ở trên để thêm.'}));
SAVED.forEach(function(s){var cur=s.current||isCur(s.ssid),st=LAST[s.last];
ul.appendChild(h('li',{cls:'sv'},[s.seen?bars(nb(s),s.rssi):null,h('span',{cls:'nm',txt:s.ssid}),
cur?h('span',{cls:'tag ok',txt:'Đang dùng'}):st?h('span',{cls:'tag '+st[1],txt:st[0]}):null,
h('span',{cls:'acts'},[cur?null:h('button',{type:'button',cls:'btn sm','aria-label':'Kết nối “'+s.ssid+'”',txt:'Kết nối',
onclick:function(){act('/api/wifi/connect',{ssid:s.ssid},s.ssid,null,this)}}),
h('button',{type:'button',cls:'btn gh sm','aria-label':'Xóa “'+s.ssid+'”',txt:'Xóa',onclick:function(){forget(s.ssid)}})])]))})}
async function forget(ssid){if(!confirm('Xóa mạng “'+ssid+'” khỏi thiết bị?'))return;
try{var r=await post('/api/wifi/remove',{ssid:ssid});if(!r.ok&&r.st!==404)ferr(null,errOf(r))}catch(e){ferr(null,'Không gửi được yêu cầu, hãy kiểm tra kết nối với thiết bị.')}
loadSaved()}

async function setPortal(on){
if(on&&!confirm('Bật Wi-Fi cấu hình? Thiết bị sẽ phát Wi-Fi riêng để cài đặt bằng điện thoại.'))return;
if(!on&&S&&!S.up&&!confirm('Thiết bị chưa nối mạng nào: tắt Wi-Fi cấu hình thì sẽ không vào được trang này nữa. Vẫn tắt?'))return;
var b=$('pBtn');b.disabled=true;
try{var r=await post('/api/wifi/portal',{on:on?1:0});if(!r.ok)ferr(null,errOf(r));else{if(S){S.portal=!!(r.j&&r.j.portal);S.portalReason=S.portal?'manual':''}if(!on)offMsg();if(S)paint()}}
catch(e){if(!on)offMsg()}
finally{b.disabled=false;kick(800)}}
function offMsg(){var k=[h('b',{txt:'Đã tắt Wi-Fi cấu hình.'})];
if(S&&S.up)k.push(h('p',null,['Hãy nối điện thoại về Wi-Fi ',qs(S.ssid),S.ip?' rồi mở http://'+S.ip+'/':'','.']));box('ok','off'+(++n0),k)}

var eyes=document.querySelectorAll('.eye');
for(var i=0;i<eyes.length;i++)eyes[i].addEventListener('click',function(){var on=this.getAttribute('aria-pressed')!=='true',inp=this.parentNode.querySelector('input');
this.setAttribute('aria-pressed',on?'true':'false');inp.type=on?'text':'password';inp.focus()});
$('scanBtn').addEventListener('click',function(){scanN=0;scan(true)});
$('pBtn').addEventListener('click',function(){setPortal(!(S&&S.portal))});
if(!window.fetch){box('bad','old',['Trình duyệt này quá cũ. Hãy mở trang bằng Chrome hoặc Safari.']);return}
poll();loadSaved();scan(false);
setInterval(function(){if(T)showTry();if(apEnd)left()},1000);
})();
</script>
</body>
</html>)WIFIPAGE";
