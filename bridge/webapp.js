import {KaraokePlayer} from './web-player.js';

// SongDeskView.buildMobile and PhoneSingingControls use these original design sizes.
const DESIGN={portrait:[420,920],singing:[420,900],landscape:[840,400]};
const prefix=location.pathname.match(/^(\/app\/feiniu-karaoke)(?:\/|$)/)?.[1]||'';
const url=path=>prefix&&path!==prefix&&!path.startsWith(prefix+'/')?prefix+path:path;
const $=id=>document.getElementById(id);
const thumbnails=new Set(['pc_logo','pc_home_music','pc_home_crown','pc_home_headphones','pc_home_queue','pc_home_stage']);
const thumbnailFailures=new Set();
const originalAsset=name=>new URL('./images/'+name+'.png',import.meta.url).href;
const asset=name=>name==='pc_home_stage'&&state.full?originalAsset(name):new URL('./images/'+(thumbnails.has(name)&&!thumbnailFailures.has(name)?'thumbs/':'')+name+'.png',import.meta.url).href;
const names={home:'首页',songs:'全部歌曲',videos:'MV / 视频',queue:'已点队列',mine:'我的',artists:'歌手',albums:'专辑',genres:'风格',languages:'语种',charts:'排行榜',favorites:'我的收藏',history:'最近演唱',playlists:'歌单',local:'本地文件'};
const state={page:'home',filter:'全部',query:'',pageNumber:1,total:0,items:[],group:'',groupKind:'',chart:'hot',letter:'',area:-1,artistType:-1,full:false,ready:false,connecting:false,connectionError:'',loading:false,serial:0,abort:null,context:null,queue:[],favorites:[],history:[],results:[],playlists:{},local:[],player:{},proof:'',proofUntil:0};
const objectUrls=new Map();
const lyricFiles=new Map();
let recordSequence=0;
// These are only local record IDs, never authentication tokens or other secrets.
export function makeRecordId(random=globalThis.crypto){
  try{if(typeof random?.randomUUID==='function')return random.randomUUID();}catch{}
  try{if(typeof random?.getRandomValues==='function'){const bytes=new Uint8Array(16);random.getRandomValues(bytes);return Array.from(bytes,value=>value.toString(16).padStart(2,'0')).join('');}}catch{}
  return 'record-'+Date.now().toString(36)+'-'+(++recordSequence).toString(36)+'-'+Math.random().toString(36).slice(2);
}
export function defaultSettings(){return {volume:.8,pitch:0,rate:1,micVolume:.7,effect:'original',offset:0,scoring:false,monitoring:false,deviceId:'',videoScale:'contain',eq:{bass:0,mid:0,treble:0},bands:Array(10).fill(0),preamp:0};}
let storageKey='',toastTimer,searchTimer,proofRefresh,playSerial=0,scopeSerial=0,startSerial=0,playingKey='',playingQueueId='',settingsState=defaultSettings();
const pitchHistory=[];
const recordedPlays=new Set();
const settledScores=new Set();

function prepareImage(image){
  image.loading='lazy';image.decoding='async';
  const fallback=()=>{const source=image.src||image.getAttribute('src')||'';const match=source.match(/\/images\/thumbs\/([a-z0-9_]+)\.png(?:[?#]|$)/);if(!match)return;thumbnailFailures.add(match[1]);image.removeEventListener('error',fallback);image.src=source.replace('/images/thumbs/','/images/');};
  image.addEventListener('error',fallback);
  if(image.complete&&image.naturalWidth===0)fallback();
  return image;
}
function node(tag,cls='',text=''){const result=document.createElement(tag);if(cls)result.className=cls;if(text!=='')result.textContent=text;if(tag==='img')prepareImage(result);return result;}
function toast(message){$('toast').textContent=String(message||'操作未完成，请重试');$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>{$('toast').hidden=true;},5000);}
function failure(error){return error?.name==='AbortError'?'':(error?.message||'操作未完成，请检查网络后重试');}
function act(fn){return async event=>{try{await fn(event);}catch(error){const message=failure(error);if(message)toast(message);}};}
function button(text,cls,fn){const value=node('button',cls,text);value.type='button';value.addEventListener('click',act(fn));return value;}
function icon(key,label,cls,fn){const value=button('',`icon-button ${cls||''}`,fn);value.setAttribute('aria-label',label);const image=node('img');image.src=asset('pc_icon_'+key);image.alt='';value.append(image);return value;}
function songId(song){return String(song?.song_id??song?.id??'');}
function key(song){return song?.local?String(song.id):'nas:'+songId(song);}
function title(song){return String(song?.title||song?.name||'未命名歌曲');}
function artist(song){return String(song?.artist||song?.singer||'未标注歌手');}
function format(value){const seconds=Math.max(0,Math.floor(Number(value)||0));return `${Math.floor(seconds/60).toString().padStart(2,'0')}:${(seconds%60).toString().padStart(2,'0')}`;}
function image(song,cls){const value=node('img',cls);value.alt='';value.loading='lazy';value.src=song?.local?(song.coverUrl||asset('pc_home_music')):url('/api/cover/'+encodeURIComponent(songId(song)));value.addEventListener('error',()=>{value.src=asset('pc_home_music');},{once:true});return value;}
function cleanSong(song){const copy={};for(const field of ['id','song_id','queueId','title','artist','singer','album','genre','language','media_kind','format','duration_ms','local','fileName','size','lastModified'])if(song[field]!==undefined)copy[field]=song[field];return copy;}
function save(){if(!storageKey)return;try{localStorage.setItem(storageKey,JSON.stringify({version:1,queue:state.queue.map(cleanSong),favorites:state.favorites.map(cleanSong),history:state.history.map(row=>({...cleanSong(row),playedAt:row.playedAt})),playlists:Object.fromEntries(Object.entries(state.playlists).map(([name,rows])=>[name,rows.map(cleanSong)])),local:state.local.map(cleanSong),results:state.results.slice(0,20),settings:settingsState}));}catch{throw Error('浏览器无法保存本机记录，请检查可用存储空间或隐私模式。');}}
function restore(){let saved;try{saved=JSON.parse(localStorage.getItem(storageKey)||'null');}catch{toast('本机记录无法读取，已保留原记录并使用空列表。');return;}if(!saved||saved.version!==1)return;for(const field of ['queue','favorites','history','local'])state[field]=Array.isArray(saved[field])?saved[field].filter(row=>row&&typeof row==='object'&&songId(row)).slice(0,field==='history'?200:2000):[];state.playlists=saved.playlists&&typeof saved.playlists==='object'&&!Array.isArray(saved.playlists)?Object.fromEntries(Object.entries(saved.playlists).filter(([name,rows])=>name.length<=100&&Array.isArray(rows)).map(([name,rows])=>[name,rows.filter(row=>row&&typeof row==='object'&&songId(row)).slice(0,2000)])):{};state.results=Array.isArray(saved.results)?saved.results.filter(row=>row&&typeof row==='object'&&Number.isFinite(row.score)).slice(0,20):[];if(saved.settings&&typeof saved.settings==='object'){settingsState={...defaultSettings(),...saved.settings,eq:{...defaultSettings().eq,...saved.settings.eq}};if(!Array.isArray(saved.settings.bands))settingsState.bands=[settingsState.eq.bass,settingsState.eq.bass,settingsState.eq.bass/2,settingsState.eq.mid,settingsState.eq.mid,settingsState.eq.mid,settingsState.eq.treble/2,settingsState.eq.treble,settingsState.eq.treble,settingsState.eq.treble];}if(state.local.length)toast('本地文件记录已保留；刷新后请重新选择文件，才能继续播放。');}

async function api(path,options={}){
  const method=options.method||'GET';
  if(prefix&&path!=='/api/tv-auth/session'&&method!=='GET'&&Date.now()/1000>=state.proofUntil-5){if(!proofRefresh)proofRefresh=api('/api/tv-auth/session').finally(()=>{proofRefresh=null;});await proofRefresh;}
  const headers={...options.headers};
  if(path==='/api/tv-auth/session')headers['X-Karaoke-Origin']=location.origin;
  if(state.proof)headers['X-Karaoke-Proof']=state.proof;
  let response;try{response=await fetch(url(path),{...options,method,headers,credentials:'same-origin'});}catch(error){if(error.name==='AbortError')throw error;throw Error('暂时无法连接曲库，请检查网络后重试。');}
  const data=await response.json().catch(()=>null);
  if(!response.ok){if(response.status===401){state.ready=false;showLogin();}const error=Error(data?.error||data?.message||(response.status===401?'请登录后继续。':`操作未完成（${response.status}），请重试。`));error.status=response.status;throw error;}
  if(path==='/api/tv-auth/session'){state.proof=typeof data?.gatewayProof==='string'?data.gatewayProof:'';state.proofUntil=Number(data?.gatewayProofExpiresAt)||0;}
  return data;
}
prepareImage($('stageCover'));
const player=new KaraokePlayer({media:$('media'),api,onState:updatePlayer,onEnded:snapshot=>{settleScore(snapshot,'歌曲结束');advance().catch(error=>toast(failure(error)));},onError:toast});

function resize(){const wide=state.full&&window.innerWidth>window.innerHeight;const [w,h]=state.full?(wide?DESIGN.landscape:DESIGN.singing):DESIGN.portrait;const scale=Math.min(window.innerWidth/w,window.innerHeight/h);const app=$('appCanvas');app.style.width=w+'px';app.style.height=h+'px';app.style.transform=`scale(${scale})`;app.style.left=Math.max(0,(window.innerWidth-w*scale)/2)+'px';app.style.top=Math.max(0,(window.innerHeight-h*scale)/2)+'px';app.classList.toggle('wide',wide);const microphone=document.querySelector('.sing-mic');if(microphone)microphone.textContent=wide?'麦克风':'话筒';}
window.addEventListener('resize',()=>{if(state.player.song&&window.innerWidth>window.innerHeight&&!state.full)fullScreen(true);else resize();});
function fullScreen(enabled=true){state.full=enabled;$('appCanvas').classList.toggle('singing',enabled);$('singingControls').hidden=!enabled;if(!state.player.song||state.player.song.media_kind==='mv')$('stageCover').src=enabled?originalAsset('pc_home_stage'):asset('pc_home_stage');if(enabled)buildSingingControls();resize();}
function dialog(titleText,content){$('dialogTitle').textContent=titleText;$('dialogBody').replaceChildren(content);if(!$('dialog').open)$('dialog').showModal();}
function closeDialog(){$('dialog').close();}
$('dialogClose').onclick=closeDialog;
$('stageExpand').onclick=()=>fullScreen();
function menu(titleText,entries,description=''){const body=node('div','dialog-menu');if(description)body.append(node('p','dialog-description',description));for(const [label,fn] of entries)body.append(button(label,'',async()=>{closeDialog();await fn();}));dialog(titleText,body);}
function navigate(page,options={}){state.page=page;state.query=options.query||'';state.group=options.group||'';state.groupKind=options.groupKind||'';state.pageNumber=1;state.filter=options.filter||(page==='videos'?'MV':'全部');state.letter='';fullScreen(false);renderPage();return loadPage();}
function back(){if(state.group)return navigate(state.page);return navigate('home');}
function buildNavigation(){const nav=$('navigation');nav.replaceChildren();for(const [page,label,ic] of [['home','首页','home'],['songs','点歌','songs'],['queue','已点','queue'],['mine','我的','accounts']]){const value=button('',`nav-button ${state.page===page?'active':''}`,()=>navigate(page));value.setAttribute('aria-label',label);const im=node('img');im.src=asset('pc_icon_'+ic);im.alt='';value.append(im,node('span','',label));nav.append(value);}}
function searchForm(home=false){const form=node('form','search');form.setAttribute('role','search');const input=node('input');input.type='search';input.value=state.query;input.placeholder=state.page==='local'||state.filter==='本地'?'搜索本地歌曲、歌手':'搜索歌曲、歌手或拼音';input.setAttribute('aria-label','搜索歌曲、歌手或拼音');input.autocomplete='off';const submit=node('button','','⌕');submit.type='submit';submit.setAttribute('aria-label','搜索');form.append(input,submit);const search=async()=>{state.query=input.value.trim();state.pageNumber=1;if(home)await navigate('songs',{query:state.query});else await loadPage();};form.addEventListener('submit',act(async event=>{event.preventDefault();clearTimeout(searchTimer);await search();}));input.addEventListener('input',()=>{if(home)return;clearTimeout(searchTimer);searchTimer=setTimeout(()=>{search().catch(error=>toast(failure(error)));},300);});return form;}
function renderPage(){
  const page=node('div',`page-view ${state.page==='home'?'home-view':''}`);
  $('page').replaceChildren(page);
  $('appCanvas').classList.toggle('no-preview',state.page!=='home');
  buildNavigation();
  if(state.page==='home'){buildHome(page);return;}
  page.append(icon('back','返回','page-back',back),node('h1','page-title',state.group||names[state.page]),icon('sound','音效与音响','page-audio',showAudio));
  if(state.page==='mine'){buildMine(page);return;}
  page.append(searchForm());
  const body=node('div','catalog-body');body.id='catalogBody';page.append(body);
  if(['songs','videos','local'].includes(state.page)){
    const filters=node('div','filters');
    for(const label of ['全部','音频','MV','NAS','本地'])filters.append(button(label,`filter ${state.filter===label?'active':''}`,async()=>{if(state.page==='local'&&label==='NAS'){await navigate('songs',{filter:'NAS'});return;}state.filter=label;state.pageNumber=1;renderPage();await loadPage();}));
    page.append(filters,node('span','song-heading','歌曲'),button('筛选','kind-button',showFilters));
    body.classList.add('song-body');page.append(button(`已点 ${state.queue.length}`,'float-queue',()=>navigate('queue')));
  }
  if(['artists','albums','genres','languages','playlists','charts'].includes(state.page)&&!state.group){
    body.style.top='183px';body.style.height='661px';
    const controls=node('div','group-controls');
    if(state.page==='artists'){
      body.style.top='287px';body.style.height='557px';controls.classList.add('artist-controls');
      for(const [field,label,choices] of [
        ['area','地区',[[-1,'全部'],[7,'华语'],[96,'欧美'],[8,'日本'],[16,'韩国'],[0,'其他']]],
        ['artistType','歌手类型',[[-1,'全部'],[1,'男歌手'],[2,'女歌手'],[3,'乐队 / 组合']]],
        ['letter','首字母',[['','热门'],...[...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map(value=>[value,value]),['#','#']]]
      ]){
        const row=node('div',`artist-chip-row ${field==='letter'?'letters':''}`);
        for(const [value,text] of choices){
          const chip=button(text,`artist-chip ${state[field]===value?'active':''}`,async()=>{state[field]=value;state.pageNumber=1;renderPage();await loadPage();});
          chip.setAttribute('aria-label',label+' '+text);chip.setAttribute('aria-pressed',String(state[field]===value));if(text.length>4)chip.classList.add('long');row.append(chip);
        }
        controls.append(row);
      }
    }
    if(state.page==='charts'){
      const select=node('select');select.setAttribute('aria-label','选择排行榜');
      for(const [value,label] of [['hot','热歌榜'],['new','新歌榜'],['rising','飙升榜'],['original','原创榜'],['local','本机常唱榜'],['nas','NAS 常唱榜']]){
        const option=node('option','',label);option.value=value;select.append(option);
      }
      select.value=state.chart;select.onchange=act(async()=>{state.chart=select.value;state.pageNumber=1;await loadPage();});controls.append(select);
    }
    if(state.page!=='artists')controls.append(button(state.page==='playlists'?'新建歌单':'更新','soft-button',state.page==='playlists'?()=>newPlaylist():()=>loadPage(true)));
    page.append(controls);
  }
  body.append(node('div','empty','正在读取曲库…'));
}
function connectionNotice(body){
  body.replaceChildren(node('p','group-message',state.connectionError||'正在连接 NAS，确认当前账号后读取本机记录。'),button('重新连接','soft-button',async()=>{closeDialog();await start();}));
}
function buildHome(page){
  const logo=node('img','logo');logo.src=asset('pc_logo');logo.alt='';page.append(logo,node('div','brand','K歌'),node('div','motto','让音乐点亮生活'),searchForm(true));
  const cards=node('div','home-cards');for(const [name,sub,imageName,target] of [['全部歌曲','海量曲库任你唱','pc_home_music','songs'],['MV / 视频','精彩MV 随心看','pc_icon_videos','videos'],['排行榜','热门新歌 一网打尽','pc_home_crown','charts'],['歌手','发现喜爱的歌手','pc_icon_artists','artists'],['已点','查看待唱歌曲','pc_home_queue','queue'],['人声音效','多种音效 随心演唱','pc_home_headphones','audio']]){const card=button('','home-card',()=>target==='audio'?showAudio():navigate(target));card.setAttribute('aria-label',name);const im=node('img');im.src=asset(imageName);im.alt='';card.append(im,node('strong','',name),node('small','',sub),node('span','arrow','›'));cards.append(card);}
  page.append(cards,node('div','recent-heading','最近播放'),button('查看更多 ›','recent-more',()=>navigate('history')));
  const recent=node('div','recent-grid');recent.id='recentGrid';page.append(recent);
  const history=state.ready?state.history:[];
  for(const song of history.slice(0,4)){const card=button('','recent-card',()=>enqueue(song));card.append(image(song,''),node('strong','',title(song)),node('small','',artist(song)));recent.append(card);}
  if(!state.ready)connectionNotice(recent);else if(!history.length)recent.append(node('div','group-message','播放歌曲后显示最近记录'));
  const current=state.ready?state.player.song:null;
  const mini=node('div','mini-player');mini.append(image(current||{local:true},'mini-cover'));const info=button('','mini-info',()=>fullScreen());info.id='miniInfo';info.append(node('strong','',title(current||{title:'尚未播放'})),node('small','',current?artist(current):'点歌后开始演唱'));mini.append(info,icon('favorites','收藏当前歌曲','',()=>{if(!state.player.song){toast('请先播放一首歌');return;}toggleFavorite(state.player.song);}),icon(state.player.playing?'pause':'play','播放 / 暂停','play-icon',()=>player.toggle()),icon('next','下一首','',advance));page.append(mini);
}
function buildMine(page){const rows=node('div','my-list');for(const [name,ic,fn] of [['账号管理','accounts',()=>sources(false)],['网盘挂载','cloud',()=>sources(true)],['本地文件','folder',()=>navigate('local',{filter:'本地'})],['我的收藏','favorites',()=>navigate('favorites')],['歌单','playlists',()=>navigate('playlists')],['最近演唱','history',()=>navigate('history')],['音效与音响','sound',showAudio],['设置','settings',showSettings]]){const row=button('','my-row',fn);const im=node('img');im.src=asset('pc_icon_'+ic);im.alt='';row.append(im,node('span','',name),node('span','arrow','›'));rows.append(row);}page.append(rows);}

function artistNormalized(value){return String(value).normalize('NFKC').toLocaleLowerCase().replace(/^\s*\d{2,}[.、_-]\s*/,'').replace(/[\s·・.\-_'’]/g,'');}
async function discoveryChart(key,signal,force=false){
  const path='/api/web/discovery/charts?key='+encodeURIComponent(key);
  if(force)return api(path+'&refresh=1',{signal});
  try{
    const cached=await api(path+'&cached=1',{signal});
    api(path,{signal}).then(result=>{
      if(!signal.aborted&&state.page==='charts'&&state.chart===key){state.chartData=result;renderChartBody(result);}
    }).catch(error=>{if(error.name!=='AbortError')toast('已显示缓存榜单；更新未完成：'+failure(error));});
    return cached;
  }catch(error){if(error.status!==404)throw error;return api(path,{signal});}
}
function renderChartBody(data){
  const body=$('catalogBody');if(!body)return;body.replaceChildren();
  const status=node('p','group-message',`${data.source||'公开榜单'} · ${data.stale?'缓存可能过期':data.cached?'已读取缓存':'已更新'} · 仅播放你曲库中匹配的录音`);
  if(data.sourceUrl){const link=node('a','','查看来源');link.href=data.sourceUrl;link.target='_blank';link.rel='noopener';link.style.marginLeft='8px';status.append(link);}
  body.append(status);
  const rows=(data.rows||[]).filter(row=>match(row,state.query));state.total=rows.length;state.pageNumber=Math.min(state.pageNumber,Math.max(1,Math.ceil(rows.length/8)));
  if(!rows.length)body.append(node('div','empty','暂无符合条件的榜单歌曲。'));
  for(const item of rows.slice((state.pageNumber-1)*8,state.pageNumber*8)){
    const row=node('div','song-row');const rank=node('span','chart-rank',String(item.rank||''));
    const info=node('div','song-info');info.append(node('strong','',item.title),node('small','',item.artist));
    const matches=item.matches||[];const choose=button(matches.length?'点歌':'暂无录音','song-action',async()=>{
      if(matches.length===1)await enqueue(matches[0]);
      else menu('选择曲库中的录音',matches.map(song=>[title(song)+' · '+artist(song)+' · '+(song.media_kind==='mv'?'MV':'音频'),()=>enqueue(song)]));
    });choose.disabled=!matches.length;row.append(rank,info,choose);body.append(row);
  }
  pagination(body,rows.length,8);
}
async function loadPage(force=false){
  if(!state.ready){const body=$('catalogBody');if(body)connectionNotice(body);return;}
  if(['home','mine'].includes(state.page)){renderPage();return;}
  state.abort?.abort();const abort=new AbortController();state.abort=abort;
  const serial=++state.serial;const page=state.page;const body=$('catalogBody');if(!body)return;
  state.loading=true;body.replaceChildren(node('div','empty','正在读取曲库…'));
  try{
    let items=[],total=0,type='songs';const query=state.query;
    const params=new URLSearchParams({q:query,page:String(state.pageNumber),pageSize:'8'});
    if(state.filter==='音频')params.set('media_kind','audio');if(state.filter==='MV')params.set('media_kind','mv');
    if(page==='charts'&&['hot','new','rising','original'].includes(state.chart)){
      const result=await discoveryChart(state.chart,abort.signal,force);
      if(serial!==state.serial)return;state.chartData=result;renderChartBody(result);return;
    }
    if(state.groupKind==='artist'){
      params.set('artist',state.group);const reply=await api('/api/songs?'+params,{signal:abort.signal});items=reply.items||[];total=reply.total||0;
    }else if(state.groupKind){
      params.set('kind',state.groupKind);params.set('value',state.group);const reply=await api('/api/web/catalog/songs?'+params,{signal:abort.signal});items=reply.items||[];total=reply.total||0;
    }else if(page==='artists'){
      const result=await api('/api/artists',{signal:abort.signal});
      items=(Array.isArray(result)?result:result.items||[]).map(row=>({name:row.artist||row.name,value:row.artist||row.name,initials:row.initials||row.pinyin||''})).filter(row=>row.name&&(!query||[row.name,row.initials].some(value=>String(value||'').toLocaleLowerCase().includes(query.toLocaleLowerCase()))));
      if(state.area!==-1||state.artistType!==-1){
        const filter=new URLSearchParams({area:String(state.area),type:String(state.artistType)});if(force)filter.set('refresh','1');
        const classification=await api('/api/web/discovery/artists?'+filter,{signal:abort.signal});const allowed=new Set(classification.names||[]);
        items=items.filter(row=>allowed.has(artistNormalized(row.name)));
        if(!classification.complete)toast('歌手分类仍有未收录项，仅显示来源已确认的歌手。');
      }
      if(state.letter)items=items.filter(row=>{const initial=(row.initials||row.name).toLocaleUpperCase().slice(0,1);return state.letter==='#'?!/[A-Z]/.test(initial):initial===state.letter;});
      total=items.length;items=items.slice((state.pageNumber-1)*12,state.pageNumber*12);type='groups';
    }else if(['albums','genres','languages'].includes(page)){
      params.set('kind',{albums:'album',genres:'genre',languages:'language'}[page]);params.set('pageSize','12');
      const reply=await api('/api/web/catalog/groups?'+params,{signal:abort.signal});items=reply.items||[];total=reply.total||0;
      if(!reply.page){items=items.filter(row=>!query||String(row.name||row.value).toLocaleLowerCase().includes(query.toLocaleLowerCase()));total=items.length;items=items.slice((state.pageNumber-1)*12,state.pageNumber*12);}
      type='groups';
    }else if(page==='playlists'&&!state.group){
      items=Object.entries(state.playlists).map(([name,rows])=>({name,value:name,count:rows.length})).filter(row=>!query||row.name.includes(query));total=items.length;items=items.slice((state.pageNumber-1)*12,state.pageNumber*12);type='groups';
    }else if(page==='charts'&&state.chart==='nas'){
      const result=await api('/api/charts',{signal:abort.signal});const rows=(Array.isArray(result)?result:result.items||[]).filter(song=>match(song,query));total=rows.length;items=rows.slice((state.pageNumber-1)*8,state.pageNumber*8);
    }else if(['queue','favorites','history','local','playlists','charts'].includes(page)||state.filter==='本地'){
      let rows=page==='queue'?state.queue:page==='favorites'?state.favorites:page==='history'?state.history:page==='playlists'?state.playlists[state.group]||[]:page==='charts'?localChart():state.local;
      rows=rows.filter(song=>match(song,query)&&mediaMatch(song));total=rows.length;items=rows.slice((state.pageNumber-1)*8,state.pageNumber*8);
    }else{
      if(state.filter==='音频')params.set('media_kind','audio');if(state.filter==='MV')params.set('media_kind','mv');const reply=await api('/api/songs?'+params,{signal:abort.signal});items=reply.items||[];total=reply.total||0;
    }
    if(serial!==state.serial)return;const maxPage=Math.max(1,Math.ceil(total/(type==='groups'?12:8)));if(state.pageNumber>maxPage){state.pageNumber=maxPage;await loadPage(force);return;}state.items=items;state.total=total;body.replaceChildren();
    if(page==='local'||state.filter==='本地'){
      body.append(node('p','group-message','本地文件仅在当前设备读取。刷新后请重新选择文件；文件不会上传 NAS。'),button('选择音乐 / MV / LRC 文件','soft-button',pickFiles));
    }
    if(page==='charts')body.append(node('p','group-message',state.chart==='nas'?'按 NAS 已完成播放记录排序。':'按当前设备的实际播放记录排序；不会读取或修改电视队列。'));
    if(page==='artists')body.append(node('p','group-message','地区和类型按公开来源确认，不从名字推测；未知分类保留在全部中。'));
    if(!items.length){
      const empty=node('div','empty',query?'未找到符合关键词的内容。':'暂无内容。');
      if(!['queue','history','favorites','playlists','local'].includes(page)&&state.filter!=='本地')empty.append(node('p','group-message','可在账号管理中连接音源，或选择当前设备的音乐文件。'),button('账号与音源','soft-button',()=>sources(false)));
      body.append(empty);
    }else if(type==='groups')renderGroups(body,items);else items.forEach(song=>body.append(songRow(song,page==='queue')));
    pagination(body,total,type==='groups'?12:8);
  }catch(error){
    if(error.name==='AbortError')return;if(serial!==state.serial)return;
    body.replaceChildren(node('div','empty',failure(error)),button('重新加载','soft-button',()=>loadPage()));throw error;
  }finally{if(serial===state.serial)state.loading=false;}
}
function match(song,q){return !q||[title(song),artist(song),song.album,song.genre,song.language].some(value=>String(value||'').toLocaleLowerCase().includes(q.toLocaleLowerCase()));}
function mediaMatch(song){return state.filter==='音频'?song.media_kind!=='mv':state.filter==='MV'?song.media_kind==='mv':true;}
function localChart(){const grouped=new Map();for(const song of state.history){const k=key(song);const current=grouped.get(k);if(current)current.plays++;else grouped.set(k,{...song,plays:1});}return [...grouped.values()].sort((a,b)=>b.plays-a.plays);}
function pagination(body,total,size){const pages=Math.max(1,Math.ceil(total/size));const nav=node('div','pagination');const previous=button('上一页','',async()=>{state.pageNumber--;await loadPage();});previous.disabled=state.pageNumber<=1;const next=button('下一页','',async()=>{state.pageNumber++;await loadPage();});next.disabled=state.pageNumber>=pages;nav.append(previous,node('span','',`${state.pageNumber} / ${pages} · ${total} 项`),next);body.append(nav);}
function renderGroups(body,items){const grid=node('div','groups-grid');for(const group of items){const card=button('','group-card',async()=>{if(state.page==='playlists')await navigate('playlists',{group:group.value});else if(state.page==='artists')await navigate('songs',{group:group.value,groupKind:'artist'});else await navigate(state.page,{group:group.value,groupKind:{albums:'album',genres:'genre',languages:'language'}[state.page]});});if(group.coverSongId)card.append(image({id:group.coverSongId},''));else card.append(node('div','group-placeholder',String(group.name||group.value||'?').slice(0,1)));card.append(node('strong','',group.name||group.value),node('small','',Number.isFinite(group.count)?`${group.count} 首`:''));grid.append(card);}body.append(grid);}
function songRow(song,isQueue){const row=node('div','song-row');const info=node('div','song-info');info.append(node('strong','',title(song)),node('small','',`${artist(song)} · ${song.local?'本地 · ':''}${song.media_kind==='mv'?'MV':'音频'}${song.local&&!objectUrls.has(key(song))?' · 请重新选择文件':''}`));const active=isQueue&&song.queueId===playingQueueId;const action=button(active?'演唱中':isQueue?'置顶':'点歌','song-action',()=>isQueue?topQueue(song):enqueue(song));action.setAttribute('aria-current',String(active));row.append(image(song,'song-cover'),info,action,button('•••','song-more',()=>songMenu(song,isQueue)));return row;}
function available(song){if(song.local&&!objectUrls.has(key(song))){menu('重新选择本地文件',[['选择文件',pickFiles]],'浏览器刷新后无法保留本地文件读取权限。请重新选择原文件；记录和歌单仍然保留。');return false;}return true;}
export function needsSavedAudio(settings){return Boolean(Number(settings.pitch)||Number(settings.preamp)||(Array.isArray(settings.bands)&&settings.bands.some(value=>Number(value)!==0))||(settings.effect&&settings.effect!=='original'));}
async function play(song){if(!song||!available(song))return;const serial=++playSerial;const local=objectUrls.get(key(song));const loaded=local?{...song,objectUrl:local,lyricsContent:lyricFiles.get(key(song))||''}:song;await player.load(loaded);if(serial!==playSerial)return;playingKey=key(song);playingQueueId=song.queueId||'';await player.setVolume(Math.max(0,Math.min(1,Number.isFinite(Number(settingsState.volume))?Number(settingsState.volume):.8)));if(needsSavedAudio(settingsState)){try{await player.prepareAudio();if(serial!==playSerial)return;if((Number(settingsState.pitch)||!player.getEffects().some(effect=>effect.id===settingsState.effect))&&!state.player.capabilities?.nativeDsp)toast('保存的原生音效未能启用，已使用当前设备可用的音频处理。');}catch(error){if(serial===playSerial&&error.name!=='AbortError')toast('保存的音效未能恢复：'+failure(error));}}if(serial!==playSerial)return;if(state.page==='home')renderPage();}
function updateQueueBadge(){for(const badge of document.querySelectorAll('.float-queue,.sing-queue'))badge.textContent=`已点 ${state.queue.length}`;}
async function enqueue(song){if(!available(song))return;const idle=state.queue.length===0||(!state.player.song&&!state.player.loading);state.queue.push({...cleanSong(song),queueId:makeRecordId()});updateQueueBadge();save();toast('已加入本机待唱：'+title(song));if(idle)await play(state.queue[0]);if(state.page==='queue')await loadPage();else if(state.page==='home')renderPage();}
async function advance(){settleScore(state.player,'切歌');if(!state.queue.length){updateQueueBadge();toast('本机队列为空，请先点歌');return;}state.queue.shift();updateQueueBadge();save();if(state.queue.length)await play(state.queue[0]);else{playSerial++;playingKey='';playingQueueId='';player.pause();toast('本机待唱队列已播完');}if(state.page==='queue')await loadPage();else if(state.page==='home')renderPage();buildSingingControls();}
async function topQueue(song){const index=state.queue.findIndex(value=>value.queueId===song.queueId);if(index<=0){if(index===0)await play(song);return;}const [value]=state.queue.splice(index,1);state.queue.splice(1,0,value);save();toast('已移到下一首');await loadPage();}
function toggleFavorite(song){const index=state.favorites.findIndex(value=>key(value)===key(song));if(index>=0)state.favorites.splice(index,1);else state.favorites.push(cleanSong(song));save();toast(index>=0?'已取消本机收藏':'已收藏到当前设备');if(state.page==='favorites')loadPage().catch(error=>toast(failure(error)));}
function songMenu(song,isQueue=false){const favorite=state.favorites.some(value=>key(value)===key(song));const entries=[['加入本机队列',()=>enqueue(song)],['加入歌单',()=>addToPlaylist(song)],[favorite?'取消收藏':'收藏',()=>toggleFavorite(song)],['歌曲信息',()=>songInformation(song)]];if(isQueue)entries.push(['移出队列',async()=>{const index=state.queue.findIndex(value=>value.queueId===song.queueId);if(index===0)await advance();else if(index>0){state.queue.splice(index,1);updateQueueBadge();save();await loadPage();}}]);menu(title(song),entries);}
function songInformation(song){const text=node('p','song-modal-info');text.textContent=[title(song),artist(song),song.album,song.genre,song.language,song.media_kind==='mv'?'MV / 视频':'音频',song.local?'当前设备本地文件':'NAS 音源'].filter(Boolean).join('\n');text.style.whiteSpace='pre-line';dialog('歌曲信息',text);}
function newPlaylist(song){const body=node('form');const input=node('input','dialog-input');input.placeholder='歌单名称';input.maxLength=80;input.required=true;const create=node('button','primary-button','创建');create.type='submit';body.append(input,create);body.addEventListener('submit',act(async event=>{event.preventDefault();const name=input.value.trim();if(!name)return;if(!Object.hasOwn(state.playlists,name))Object.defineProperty(state.playlists,name,{value:[],writable:true,configurable:true,enumerable:true});if(song&&!state.playlists[name].some(row=>key(row)===key(song)))state.playlists[name].push(cleanSong(song));save();closeDialog();toast('歌单已保存在当前设备');if(state.page==='playlists')await loadPage();}));dialog('新建歌单',body);}
function addToPlaylist(song){const entries=Object.keys(state.playlists).map(name=>[name,()=>{if(!state.playlists[name].some(row=>key(row)===key(song)))state.playlists[name].push(cleanSong(song));save();toast('已加入歌单：'+name);}]);entries.push(['＋ 新建歌单',()=>newPlaylist(song)]);menu('加入歌单',entries);}
function showFilters(){menu('歌曲与资源库',[['全部歌曲',()=>navigate('songs')],['音频',()=>navigate('songs',{filter:'音频'})],['MV / 视频',()=>navigate('videos')],['歌手',()=>navigate('artists')],['专辑',()=>navigate('albums')],['风格 / 分类',()=>navigate('genres')],['语种',()=>navigate('languages')],['本地文件',()=>navigate('local',{filter:'本地'})]]);}
function pickFiles(){$('localFiles').value='';$('localFiles').click();}
$('localFiles').addEventListener('change',act(async()=>{const scope=scopeSerial;const files=[...$('localFiles').files];const lrc=new Map();for(const file of files.filter(value=>/\.lrc$/i.test(value.name))){const text=await file.text();if(scope!==scopeSerial)return;lrc.set(file.name.replace(/\.lrc$/i,'').toLocaleLowerCase(),text);}let linkedLyrics=0;for(const song of state.local){const lyrics=lrc.get(song.fileName.replace(/\.[^.]+$/,'').toLocaleLowerCase());if(lyrics){lyricFiles.set(key(song),lyrics);linkedLyrics++;}}let added=0;for(const file of files.filter(value=>!/\.lrc$/i.test(value.name))){if(!file.type.startsWith('audio/')&&!file.type.startsWith('video/')&&!/\.(mp3|flac|wav|m4a|ogg|aac|mp4|mkv|mpg|mpeg|webm)$/i.test(file.name))continue;const existing=state.local.find(song=>song.fileName===file.name&&song.size===file.size&&song.lastModified===file.lastModified);const song=existing||{id:'local:'+makeRecordId(),local:true,title:file.name.replace(/\.[^.]+$/,''),artist:'本地文件',fileName:file.name,size:file.size,lastModified:file.lastModified,media_kind:file.type.startsWith('video/')||/\.(mp4|mkv|mpg|mpeg|webm)$/i.test(file.name)?'mv':'audio'};const k=key(song);if(!objectUrls.has(k))objectUrls.set(k,URL.createObjectURL(file));const lyrics=lrc.get(file.name.replace(/\.[^.]+$/,'').toLocaleLowerCase());if(lyrics)lyricFiles.set(k,lyrics);if(!existing)state.local.push(song);added++;}save();toast(added?`已读取 ${added} 个本地文件，未上传 NAS`:linkedLyrics?`已关联 ${linkedLyrics} 首本地歌词`:'没有可读取的音乐或 MV 文件');await navigate('local',{filter:'本地'});}));

function sources(cloud){
  const body=node('div');
  body.append(node('p','dialog-description',cloud?'在 NAS 的夸克音源页完成官方账号授权，然后浏览网盘并选择挂载目录。安卓手机已有登录会话不会直接复制；需要在当前 NAS 授权。':'使用现有音源管理页连接飞牛音乐、飞牛影视或夸克网盘。账号由 NAS 管理；当前设备的待唱、收藏和歌单保持独立。'));
  const link=node('a','primary-button',cloud?'打开夸克账号与挂载目录':'打开飞牛音乐 / 影视音源管理');
  link.href=url(cloud?'/quark-sources':'/sources');link.target='_blank';link.rel='noopener';link.style.display='block';body.append(link);
  if(!cloud){const quark=node('a','soft-button','夸克账号与网盘挂载');quark.href=url('/quark-sources');quark.target='_blank';quark.rel='noopener';quark.style.display='block';quark.style.marginTop='12px';quark.style.textAlign='center';body.append(quark);}
  dialog(cloud?'网盘挂载':'账号管理',body);
}
function range(body,label,min,max,step,value,fn,suffix=''){const box=node('label','setting');const caption=node('strong','',`${label}：${value}${suffix}`);const input=node('input');input.type='range';input.min=String(min);input.max=String(max);input.step=String(step);input.value=String(value);input.setAttribute('aria-label',label);input.addEventListener('input',()=>{caption.textContent=`${label}：${input.value}${suffix}`;});input.addEventListener('change',act(()=>fn(Number(input.value))));box.append(caption,input);body.append(box);return input;}
function toggle(body,label,checked,fn){const box=node('label','setting');const input=node('input');input.type='checkbox';input.checked=Boolean(checked);input.addEventListener('change',act(async()=>{try{await fn(input.checked);}catch(error){input.checked=!input.checked;throw error;}}));box.append(input,node('span','',label));body.append(box);return input;}
function unsupported(body,message){body.append(node('p','dialog-description',message));}
async function showAudio(){
  const scope=scopeSerial;
  const loading=node('p','dialog-description','正在准备当前设备音效…');dialog('音效与音响 · 当前设备',loading);
  try{if(player.prepareAudio)await player.prepareAudio();if(scope!==scopeSerial)return;await player.setEq({bands:settingsState.bands,preamp:settingsState.preamp||0});if(scope!==scopeSerial)return;if(state.player.capabilities?.pitch)await player.setPitch(settingsState.pitch||0);if(scope!==scopeSerial)return;if(settingsState.effect==='custom'&&settingsState.voiceParameters&&state.player.capabilities?.nativeDsp)await player.setVoiceParameters(settingsState.voiceParameters);else await player.setEffect(player.getEffects?.().some(effect=>effect.id===settingsState.effect)?settingsState.effect:'original');}catch(error){if(error.name!=='AbortError'&&scope===scopeSerial)toast('原生音效准备未完成：'+failure(error));}
  if(scope!==scopeSerial)return;
  if(!$('dialog').open||$('dialogTitle').textContent!=='音效与音响 · 当前设备')return;
  const body=node('div');
  const device=node('section','setting');device.append(node('strong','','设备设置'));if(state.player.tracks?.length>1){const select=node('select','dialog-input');select.setAttribute('aria-label','MV 音轨');state.player.tracks.forEach((track,index)=>{const option=node('option','',track.name||`音轨 ${index+1}`);option.value=String(index);select.append(option);});select.value=String(state.player.selectedTrack||0);select.onchange=act(async()=>{try{await player.setAudioTrack(Number(select.value));}finally{select.value=String(state.player.selectedTrack||0);}});device.append(node('small','','MV 音轨 · 没有原唱 / 伴奏标记时可试听选择'),select);}
  range(device,'音乐 / MV 音量',0,100,1,Math.round((state.player.volume??settingsState.volume)*100),async value=>{settingsState.volume=value/100;await player.setVolume(value/100);save();},'%');
  range(device,'歌词同步',-3000,3000,100,settingsState.offset,value=>{settingsState.offset=value;player.setLyricsOffset(value);save();},' ms');
  if(state.player.capabilities?.pitch)range(device,'升降调',-12,12,1,state.player.pitch||settingsState.pitch,async value=>{await player.setPitch(value);settingsState.pitch=value;save();},' 半音');
  else unsupported(device,'当前浏览器未能启用独立音乐升降调。');
  range(device,'播放速度',.5,1.5,.05,settingsState.rate,async value=>{await player.setRate(value);settingsState.rate=value;save();},' 倍');
  device.append(button('麦克风与收音设置','primary-button',showMicrophone));body.append(device);
  const music=node('section','setting');music.append(node('strong','','音乐 / MV 音效'));
  if(state.player.capabilities?.equalizer){
    const bands=state.player.eqBands?.slice()||Array(10).fill(0);
    for(const [index,hz] of [60,170,310,600,1000,3000,6000,12000,14000,16000].entries()){
      range(music,`${hz} Hz`,-12,12,1,bands[index]||0,async value=>{
        const next=(state.player.eqBands||bands).slice();next[index]=value;await player.setEq({bands:next,preamp:settingsState.preamp||0});settingsState.bands=next;save();
      },' dB');
    }
    range(music,'前级增益',-20,12,1,settingsState.preamp||0,async value=>{await player.setEq({bands:state.player.eqBands||bands,preamp:value});settingsState.preamp=value;save();},' dB');
    unsupported(music,'自动保留均衡器余量，避免提升频段造成过载。');
  }else unsupported(music,'当前浏览器未能启用音乐均衡器。');
  body.append(music);
  const vocal=node('section','setting');vocal.append(node('strong','','人声效果'));
  const effects=player.getEffects?.()||[];
  if(effects.length){
    const grid=node('div','effect-grid');
    for(const effect of effects)grid.append(button(effect.label||effect.id,'',async()=>{await player.setEffect(effect.id);settingsState.effect=effect.id;save();toast('人声音效：'+(effect.label||effect.id));await showAudio();}));
    vocal.append(grid);
  }
  if(state.player.capabilities?.nativeDsp&&player.getVoiceParameters){
    const details=node('div');details.hidden=true;
    vocal.append(button('18 项参数','soft-button',()=>{details.hidden=!details.hidden;}));
    player.getVoiceParameters().forEach((parameter,index)=>{
      range(details,parameter.name,parameter.min,parameter.max,parameter.step,state.player.voiceParameters?.[index]??parameter.initial,async value=>{
        const values=(state.player.voiceParameters||player.getVoiceParameters().map(param=>param.initial)).slice();values[index]=value;
        await player.setVoiceParameters(values);settingsState.voiceParameters=values;settingsState.effect='custom';save();
      },' '+parameter.unit);
    });
    vocal.append(details);
  }else unsupported(vocal,'原生人声模块未加载时，仅显示当前可用的效果。');
  body.append(vocal);unsupported(body,'音响由当前设备系统选择。蓝牙、USB 与多音响路由仍需要在当前设备实际试听确认。');
  dialog('音效与音响 · 当前设备',body);
}
async function showMicrophone(){const body=node('div');const capability=state.player.capabilities||{};if(!capability.secureContext||!navigator.mediaDevices?.getUserMedia){unsupported(body,'当前入口不能申请麦克风。请通过支持安全麦克风授权的飞牛访问入口打开；音乐和 MV 仍可在本机播放。');dialog('麦克风 / 人声输出',body);return;}toggle(body,'把当前设备当麦克风',state.player.micEnabled,async enabled=>{await player.setMicrophone(enabled,{monitor:settingsState.monitoring,deviceId:settingsState.deviceId});if(enabled)player.setMicVolume(settingsState.micVolume);save();});toggle(body,'播放本机收音人声',settingsState.monitoring,async enabled=>{await player.setMicrophone(true,{monitor:enabled,deviceId:settingsState.deviceId});settingsState.monitoring=enabled;save();});range(body,'人声音量',0,100,1,Math.round(settingsState.micVolume*100),async value=>{await player.setMicVolume(value/100);settingsState.micVolume=value/100;save();},'%');const select=node('select','dialog-input');select.setAttribute('aria-label','收音麦克风');const defaultOption=node('option','','系统默认麦克风');defaultOption.value='';select.append(defaultOption);try{const devices=await navigator.mediaDevices.enumerateDevices();for(const device of devices.filter(value=>value.kind==='audioinput')){const option=node('option','',device.label||`麦克风 ${select.options.length}`);option.value=device.deviceId;select.append(option);}if(![...select.options].some(option=>option.value===settingsState.deviceId))settingsState.deviceId='';select.value=settingsState.deviceId;select.onchange=act(async()=>{await player.setMicrophone(true,{monitor:settingsState.monitoring,deviceId:select.value});settingsState.deviceId=select.value;save();});body.append(select);}catch(error){unsupported(body,'无法读取麦克风设备列表：'+failure(error));}unsupported(body,'系统授权后才会收音。监听人声时请使用耳机；USB / 有线 / 蓝牙的实际路由由浏览器和设备系统决定。Android 自动发现电视的局域网传声尚未提供。');dialog('麦克风 / 人声输出',body);}
function settleScore(snapshot,reason){const song=snapshot?.song;const result=snapshot?.score;if(!state.ready||!song||result?.score==null||!Number.isFinite(result.score))return;const id=(song.queueId||key(song))+':take:'+(snapshot.takeCounter||0);if(settledScores.has(id))return;settledScores.add(id);state.results.unshift({title:title(song),artist:artist(song),score:result.score,grade:result.grade,pitch:result.pitch,rhythm:result.rhythm,coverage:result.coverage,frames:result.frames,partial:Boolean(result.partial)||reason!=='歌曲结束',reason,at:Date.now()});state.results=state.results.slice(0,20);try{save();}catch(error){toast(failure(error));}}
function showResults(){const body=node('div');if(!state.results.length)body.append(node('p','dialog-description','暂无有效演唱结算。开启麦克风和评分后，歌曲结束或切歌时保存真实结果。'));for(const result of state.results){const card=node('section','setting');card.append(node('strong','',result.title+' · '+result.artist),node('p','',`${result.partial?'片段':'整首'} ${result.grade||''} ${result.score} 分`),node('small','',`音准 ${result.pitch} · 节奏 ${result.rhythm} · 完成度 ${result.coverage}% · ${result.frames} 个有效采样`));body.append(card);}dialog('演唱结算 · 最近20首',body);}
function lyricSettings(){const body=node('div');range(body,'歌词提前 / 延后',-10000,10000,100,settingsState.offset,value=>{settingsState.offset=value;player.setLyricsOffset(value);save();},' ms');const scale=node('select','dialog-input');scale.setAttribute('aria-label','横屏画面');for(const [value,label] of [['contain','完整画面（保留黑边）'],['cover','铺满屏幕（保持比例，裁掉边缘）']]){const option=node('option','',label);option.value=value;scale.append(option);}scale.value=settingsState.videoScale||'contain';scale.onchange=act(()=>{settingsState.videoScale=scale.value;$('appCanvas').style.setProperty('--video-fit',scale.value);save();});body.append(node('p','dialog-description','竖屏始终保持 MV 原始比例；以下设置用于横屏全屏画面。'),scale);toggle(body,'开启演唱评分',settingsState.scoring,async enabled=>{if(typeof player.setScoring!=='function')throw Error('当前播放器尚未提供演唱评分');await player.setScoring(enabled);settingsState.scoring=enabled;save();toast(enabled?'已开启参考谱读取与演唱评分':'已关闭演唱评分');});body.append(node('p','dialog-description',state.player.scoreMessage||'有可靠参考谱且获得麦克风权限时才会计分。没有参考谱时显示自由演唱，不产生模拟成绩。'));const lyrics=node('p','song-modal-info');lyrics.style.whiteSpace='pre-line';lyrics.textContent=(state.player.lyrics||[]).map(line=>line.text).join('\n')||state.player.plainLyrics||'暂无可读取歌词';body.append(lyrics);dialog('歌词 / 演唱评分',body);}
function showAbout(){const body=node('div');body.append(node('p','dialog-description','K歌是由 FXD 维护、基于麦动（Maidong KTV）的第三方 NAS 独立演唱版本。'),node('p','dialog-description','原作者：杨家三郎。'));const original=node('a','dialog-description','原项目：coolwuzizai/maidong-ktv');original.href='https://github.com/coolwuzizai/maidong-ktv';original.target='_blank';original.rel='noopener noreferrer';body.append(original,node('p','dialog-description','保留《麦动 App 软件许可及非商用协议》。分发条件：完全免费、公开源码、禁止商用。'));dialog('关于 K歌',body);}
function showScoreCenter(){
  const body=node('div'),connection=node('p','dialog-description'),pending=node('p','dialog-description'),destination=node('div');
  const update=()=>{const hub=player.scoreHub?.state()||{};connection.textContent=hub.connected&&hub.authenticated?'已连接当前飞牛账号':hub.message||'评分中心暂未连接';pending.textContent=`当前账号待同步成绩：${Number.isSafeInteger(hub.pendingResults)&&hub.pendingResults>=0?hub.pendingResults:0} 首`;destination.replaceChildren();if(hub.connected&&hub.authenticated&&hub.binding){const open=node('a','primary-button','打开 K歌评分');open.href='/app/kge-score/';open.target='_blank';open.rel='noopener';destination.append(open);}else destination.append(node('p','dialog-description','请从飞牛桌面安装或打开「K歌评分」，再重新检查连接。'));};
  update();body.append(connection,pending,node('p','dialog-description','使用当前飞牛登录账号。完整演唱的有效成绩会自动同步；断网待办在原账号恢复连接后重试。读取评分谱不会扫描整个曲库。'));
  body.append(button('重新检查连接','soft-button',async()=>{await player.scoreHub?.refreshSession();await player.scoreHub?.flush();update();}),destination);
  dialog('评分中心 · 当前飞牛账号',body);
}
function showSettings(){menu('K歌 · 本机独立播放',[['音乐来源 · NAS 曲库',()=>navigate('songs')],['选择当前设备音乐 / MV / LRC 文件',pickFiles],['连接与媒体来源',()=>sources(false)],['评分中心 · 连接与同步',showScoreCenter],['歌词 / 演唱评分',lyricSettings],['查看演唱结算',showResults],['麦克风 / 人声输出',showMicrophone],['音效与音响',showAudio],['资源库 · 专辑 / 风格 / 语种',showFilters],['本机保存与能力说明',()=>{const text=node('p','dialog-description','队列、收藏、歌单和最近记录按 NAS 与登录身份保存在当前浏览器。本地文件不会上传；刷新后需重选。通过相同源算法提供可用的均衡器、人声音效与评分；实际听感和飞牛手机宿主权限仍需真机验收。夸克登录由 NAS 官方授权页完成；LAN 麦克风与 Android 系统音频路由仍未等同。');dialog('本机保存与能力',text);}],['关于 K歌与原作者',showAbout],['清空本机待唱队列',clearQueue]]);}
async function clearQueue(){state.queue=[];updateQueueBadge();save();playSerial++;playingKey='';playingQueueId='';await player.load(null);toast('已清空当前设备待唱队列');if(state.page==='queue')await loadPage();else if(state.page==='home')renderPage();}
function buildSingingControls(){if(!state.full)return;const body=$('singingControls');body.replaceChildren();const current=state.player.song;body.append(button('‹','glass sing-back',()=>fullScreen(false)),node('div','sing-title',current?title(current):'尚未播放'),node('div','sing-artist',current?artist(current):'点歌后开始演唱'),button('•••','glass sing-more',lyricSettings),button('已点 '+state.queue.length,'glass sing-queue',()=>navigate('queue')),button(state.player.original===false?'伴奏  /  原唱':'原唱  /  伴奏','glass sing-vocal',async()=>{if(state.player.capabilities?.original===false){toast('当前歌曲没有可切换的原唱 / 伴奏音源');return;}await player.setOriginal(state.player.original===false);}),node('div','sing-deck'));const seek=node('input','sing-seek');seek.type='range';seek.min='0';seek.max=String(state.player.duration||1);seek.step='.1';seek.value=String(state.player.position||0);seek.setAttribute('aria-label','演唱进度');seek.id='singSeek';seek.addEventListener('change',act(()=>player.seek(Number(seek.value))));body.append(seek,node('div','sing-time',format(state.player.position)+' / '+format(state.player.duration)),button('音效','glass sing-effect',showAudio),button('调音','glass sing-tune',showAudio),button('重唱','glass sing-repeat',()=>player.replay()),button('下一首','glass sing-next',advance),button(window.innerWidth>window.innerHeight?'麦克风':'话筒','glass sing-mic',showMicrophone),button(state.player.playing?'Ⅱ':'▶','glass sing-play',()=>player.toggle()));}
function updatePlayer(snapshot){state.player=snapshot||{};const song=state.player.song;if(state.ready&&state.player.playing&&song){const playId=(song.queueId||key(song))+':take:'+(state.player.takeCounter||0);if(!recordedPlays.has(playId)){recordedPlays.add(playId);state.history.unshift({...cleanSong(song),playedAt:Date.now()});state.history=state.history.slice(0,200);try{save();}catch(error){toast(failure(error));}}}const status=state.player.scoreEnabled?(state.player.scoreMessage||({waiting:'开启麦克风后开始评分',preparing:'正在准备原唱旋律',ready:'原唱旋律已就绪',unavailable:'当前歌曲暂无法评分',error:'评分参考读取未完成'}[state.player.scoreStatus]||'')):'';$('stageStatus').textContent=song?(title(song)+' · '+artist(song)+(status?'\n'+status:'')):'点歌后显示同步歌词';const score=state.player.score;$('stageScore').textContent=score?.score!=null?`${score.grade||''} ${score.score} 分`:settingsState.scoring?'等待演唱':'自由演唱';const lyrics=state.player.lyrics||[];const index=Number.isInteger(state.player.currentLyric)?state.player.currentLyric:-1;const lyricText=lyrics[index]?.text||(state.player.plainLyrics?state.player.plainLyrics.split('\n')[0]:(song?'前奏':'点一首喜欢的歌'));const highlighted=Math.max(0,Math.min(lyricText.length,Math.floor(state.player.lyricHighlight||0)));$('stageLyric').replaceChildren(node('span','lyric-highlight',lyricText.slice(0,highlighted)),document.createTextNode(lyricText.slice(highlighted)));$('stageNext').textContent=lyrics[index+1]?.text||(song?(lyrics.length?'':'暂无同步歌词'):'在当前手机或电脑播放、演唱');const cover=$('stageCover');const source=song&&song.media_kind!=='mv'?(song.local?asset('pc_home_music'):url('/api/cover/'+encodeURIComponent(songId(song)))):asset('pc_home_stage');if(cover.getAttribute('src')!==source)cover.src=source;cover.hidden=Boolean(song?.media_kind==='mv');cover.classList.toggle('album-cover',Boolean(song));const mini=document.querySelector('.mini-info');if(mini&&song){mini.children[0].textContent=title(song);mini.children[1].textContent=artist(song);}const play=document.querySelector('.mini-player .play-icon img');if(play)play.src=asset('pc_icon_'+(state.player.playing?'pause':'play'));if(state.full){const seek=$('singSeek');if(seek&&document.activeElement!==seek){seek.max=String(state.player.duration||1);seek.value=String(state.player.position||0);}const time=document.querySelector('.sing-time');if(time)time.textContent=format(state.player.position)+' / '+format(state.player.duration);const pause=document.querySelector('.sing-play');if(pause){pause.textContent=state.player.playing?'Ⅱ':'▶';pause.setAttribute('aria-label',state.player.playing?'暂停演唱':'继续演唱');}const vocal=document.querySelector('.sing-vocal');if(vocal)vocal.textContent=state.player.original===false?'伴奏  /  原唱':'原唱  /  伴奏';const name=document.querySelector('.sing-title');if(name)name.textContent=song?title(song):'尚未播放';const singer=document.querySelector('.sing-artist');if(singer)singer.textContent=song?artist(song):'点歌后开始演唱';}const sentence=state.player.currentLineScore;$('stageSentence').textContent=state.player.scoreEnabled&&sentence?(sentence.score==null?'本句 · 等待有效演唱':`本句 ${sentence.grade||''} ${sentence.score} 分 · 音准 ${sentence.pitch}`):'';drawPitch();}
function drawPitch(){
  const canvas=$('pitchLane'),context=canvas.getContext('2d');if(!context)return;
  context.clearRect(0,0,canvas.width,canvas.height);
  const melody=state.player.melody;
  if(melody?.notes?.length){
    const now=(state.player.position||0)*1000-(state.player.musicLatencyMs||0),from=Math.max(0,now-2800),to=now+4800;
    const first=Math.max(0,Math.floor(from/melody.stepMs)),last=Math.min(melody.notes.length-1,Math.ceil(to/melody.stepMs));
    const voiced=melody.notes.slice(first,last+1).filter(Number.isFinite);
    const low=voiced.length?Math.min(...voiced)-3:45,high=voiced.length?Math.max(...voiced)+3:78;
    const x=ms=>(ms-from)/(to-from)*canvas.width,y=pitch=>canvas.height-22-(pitch-low)/Math.max(12,high-low)*(canvas.height-48);
    context.fillStyle='#a9adbb';
    for(let i=first;i<=last;i++)if(Number.isFinite(melody.notes[i]))context.fillRect(x(i*melody.stepMs),y(melody.notes[i])-3,Math.max(3,canvas.width*melody.stepMs/(to-from)),6);
    context.strokeStyle='#ff465a';context.lineWidth=3;context.beginPath();let started=false;
    for(let ms=from;ms<=now;ms+=melody.stepMs){const pitch=player.actualPitchAt?.(ms);if(!Number.isFinite(pitch)){started=false;continue;}const target=melody.notes[Math.floor(ms/melody.stepMs)];let shown=pitch;if(Number.isFinite(target)){let delta=(pitch-target)%12;if(delta>6)delta-=12;if(delta< -6)delta+=12;shown=target+delta;}if(started)context.lineTo(x(ms),y(shown));else context.moveTo(x(ms),y(shown));started=true;}
    context.stroke();context.fillStyle='#ddd';context.font='20px system-ui';context.fillText('音准   ━ 原唱',0,19);context.fillStyle='#ff465a';context.fillText('━ 我的演唱',150,19);return;
  }
  if(!state.player.micEnabled)return;
  const pitch=state.player.detectedPitch;pitchHistory.push(Number.isFinite(pitch)?pitch:null);if(pitchHistory.length>100)pitchHistory.shift();
  context.strokeStyle='#ff465a';context.lineWidth=3;context.beginPath();let started=false;
  pitchHistory.forEach((value,i)=>{if(value===null){started=false;return;}const x=i/100*canvas.width,y=canvas.height-(Math.max(36,Math.min(84,value))-36)/48*canvas.height;if(started)context.lineTo(x,y);else context.moveTo(x,y);started=true;});context.stroke();
}
function showLogin(){const form=node('form');const description=node('p','dialog-description','通过飞牛应用入口登录 NAS 后可直接进入；直连服务使用应用安装时设置的 K歌服务账号。');const user=node('input','dialog-input');user.name='username';user.placeholder='K歌服务账号';user.autocomplete='username';user.required=true;const pass=node('input','dialog-input');pass.name='password';pass.placeholder='K歌服务密码';pass.type='password';pass.autocomplete='current-password';pass.required=true;const submit=node('button','primary-button','登录');submit.type='submit';form.append(description,user,pass,submit);form.addEventListener('submit',act(async event=>{event.preventDefault();const password=pass.value;pass.value='';submit.disabled=true;try{await api('/api/tv-auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:user.value.trim(),password})});closeDialog();await start();}finally{submit.disabled=false;}}));dialog('登录 K歌服务',form);}
export async function switchCatalogScope(context){
  const nextKey='feiniu-karaoke:web:'+context.catalogScope;
  if(storageKey===nextKey)return false;
  const scope=++scopeSerial;
  state.ready=false;state.abort?.abort();state.abort=null;++state.serial;++playSerial;
  clearTimeout(searchTimer);playingKey='';playingQueueId='';closeDialog();
  const stopped=player.setMicrophone(false,{monitor:false});player.setScoring(false);await stopped;
  if(scope!==scopeSerial)return false;
  await player.load(null);
  if(scope!==scopeSerial)return false;
  for(const value of objectUrls.values())URL.revokeObjectURL(value);
  objectUrls.clear();lyricFiles.clear();$('localFiles').value='';
  recordedPlays.clear();settledScores.clear();pitchHistory.length=0;
  state.queue=[];state.favorites=[];state.history=[];state.results=[];state.playlists={};state.local=[];
  state.items=[];state.total=0;state.pageNumber=1;state.group='';state.groupKind='';state.query='';state.chartData=null;
  storageKey=nextKey;settingsState=defaultSettings();restore();
  for(const song of state.queue)if(!song.queueId)song.queueId=makeRecordId();
  updateQueueBadge();return true;
}
export function applyScopeSettings(){
  // Stage current-scope DSP values synchronously; never ensure audio or ask for a microphone here.
  player.resetCachedAudioSettings(settingsState);
  player.setVolume(settingsState.volume);player.setRate(settingsState.rate);player.setLyricsOffset(settingsState.offset);
  player.setScoring(Boolean(settingsState.scoring));
  $('appCanvas').style.setProperty('--video-fit',settingsState.videoScale||'contain');
}
async function start(){
  const serial=++startSerial;
  state.ready=false;state.connecting=true;state.connectionError='';renderPage();
  try{
    await api('/api/tv-auth/session');if(serial!==startSerial)return;
    const context=await api('/api/web/context');if(serial!==startSerial)return;
    if(!context?.catalogScope)throw Error('服务尚未提供本机记录隔离信息，请升级 NAS 应用后重试。');
    await switchCatalogScope(context);if(serial!==startSerial)return;
    state.context=context;applyScopeSettings();state.ready=true;state.connecting=false;renderPage();resize();await loadPage();
  }catch(error){
    if(serial!==startSerial)return;
    const message=failure(error);state.connecting=false;state.connectionError=message||'连接尚未完成，请重新连接。';if(!state.ready){renderPage();await loadPage();}if(message)toast(message);
    if(!$('dialog').open){const body=node('div');body.append(node('p','dialog-description',message),button('重新连接','primary-button',async()=>{closeDialog();await start();}));dialog(state.ready?'读取未完成':'连接未完成',body);}
  }
}
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&state.full&&!$('dialog').open)fullScreen(false);});
window.addEventListener('pagehide',()=>{state.abort?.abort();player.destroy();for(const value of objectUrls.values())URL.revokeObjectURL(value);});
window.addEventListener('online',()=>{if(!state.ready)start();});
window.addEventListener('pageshow',event=>{if(event.persisted)location.reload();});
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&state.ready)api('/api/web/context').then(context=>{if(context.catalogScope!==state.context?.catalogScope)return start();}).catch(error=>toast(failure(error)));});
renderPage();resize();start();
