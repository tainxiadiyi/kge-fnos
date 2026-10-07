"""TV-facing adapter for the authenticated, read-only fnOS Music API.

Authentication decisions use the TCP peer, explicit LAN ranges and Host header.
Forwarded requests never inherit LAN trust. No NAS token is sent to clients.
"""
import asyncio
import base64
import hashlib
import hmac
import ipaddress
import json
import logging
import mimetypes
import os
from pathlib import Path
import secrets
import shutil
import sqlite3
import time
from urllib.parse import quote, urlsplit

from aiohttp import web, ClientSession, ClientTimeout, WSMsgType
from pitch import reference_pitch
from score_jobs import ScoreJobs
from shared_scores import SharedScores
from online_tracks import OnlineTracks
from online_lyrics import OnlineLyrics
from video_library import VideoLibrary
from catalog_sync import CatalogSync
from source_auth import SourceManager, SourceError
from video_playback import VideoPlayback
from player_targets import PlayerTargets
from web_catalog import WebCatalog
from web_discovery import WebDiscovery
from score_identity import ScoreIdentity
from fnos_gateway import base_path, gateway_middleware, scoped_url, serve, issue_gateway_proof, valid_gateway_origin_proof

COOKIE = 'maidong_session'
PLAYER_FILES = frozenset(('webapp.js', 'webapp.css', 'web-player.js', 'web-audio.js', 'web-scorehub.js', 'dsp-worklet.js'))


async def player_asset(req):
    name = req.match_info['path']
    parts = name.split('/')
    if (not name or '\\' in name or any(part in ('', '.', '..') for part in parts)
            or ':' in name or any(ord(char) < 32 for char in name)):
        raise web.HTTPNotFound()
    root = Path(__file__).resolve().parent
    if name in PLAYER_FILES:
        target = root / name
    else:
        target = root / 'web-assets' / name
        suffix = target.suffix.lower()
        license_file = 'license' in target.name.lower() and suffix in ('', '.txt', '.md')
        if suffix not in ('.png', '.jpg', '.jpeg', '.webp', '.svg', '.js', '.wasm') and not license_file:
            raise web.HTTPNotFound()
        if not target.is_file() and name in ('vendor/feiniu-dsp.js', 'vendor/feiniu-dsp.wasm'):
            root = root.parent
            target = root / 'artifacts/fnos/web-dsp' / parts[-1]
    if not target.resolve().is_relative_to(root) or not target.is_file():
        raise web.HTTPNotFound()
    candidate = target
    while candidate != root:
        if candidate.is_symlink() or getattr(candidate, 'is_junction', lambda: False)():
            raise web.HTTPNotFound()
        candidate = candidate.parent
    mime = {'.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm',
            '.md': 'text/plain', '.txt': 'text/plain'}.get(target.suffix.lower())
    return web.FileResponse(target, headers={'Content-Type': mime or mimetypes.guess_type(str(target))[0] or 'text/plain',
        'Cache-Control': 'public, max-age=0, must-revalidate', 'X-Content-Type-Options': 'nosniff'})


def local_request(peer, host, headers, networks):
    # Reverse proxies, even on the NAS, must authenticate. Never trust XFF.
    if any(k.lower() == 'forwarded' or k.lower() == 'x-real-ip' or
           k.lower().startswith(('x-forwarded-', 'x-trim-')) for k in headers):
        return False
    try:
        ip = ipaddress.ip_address(peer)
        target = ipaddress.ip_address(urlsplit('http://' + host).hostname)
        return any(ip in n for n in networks) and any(target in n for n in networks)
    except (ValueError, TypeError):
        return False


class Bridge:
    def __init__(self, config, state):
        self.cfg = config
        self.networks = [ipaddress.ip_network(n) for n in config['lan_networks']]
        self.db = sqlite3.connect(state)
        self.db.row_factory = sqlite3.Row
        self.db.executescript('''
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS songs(id INTEGER PRIMARY KEY, guid TEXT UNIQUE, data TEXT);
            CREATE TABLE IF NOT EXISTS queue(id INTEGER PRIMARY KEY AUTOINCREMENT, song_id INTEGER);
            CREATE TABLE IF NOT EXISTS history(id INTEGER PRIMARY KEY AUTOINCREMENT, song_id INTEGER, at REAL);
            CREATE TABLE IF NOT EXISTS favorites(device TEXT, song_id INTEGER, PRIMARY KEY(device,song_id));
        ''')
        self.sockets = {}
        self.socket_requests = {}
        self.player = None
        self.player_name = ''
        self.targets = PlayerTargets(self)
        self.refresh_lock = asyncio.Lock()
        self.refresh_at = 0
        self.last_error = ''
        self.lyrics_cache = {}
        self.pitch_lock = asyncio.Lock()
        self.failures = {}
        self.transcodes = {}
        self.transcode_slots = asyncio.Semaphore(2)
        self.cache = Path(config.get('cache_dir', 'audio-cache')).resolve()
        self.scores = ScoreJobs(self)
        self.shared_scores = SharedScores(self)
        self.online_tracks = OnlineTracks(self)
        self.online_lyrics = OnlineLyrics(self)
        self.videos = VideoLibrary(self.db, config.get('video_roots', []), config.get('video_cover_cache', 'video-covers'))
        self.catalog = CatalogSync(self)
        self.sources = SourceManager(self, state)
        self.video_playback = VideoPlayback(self)
        self.web_catalog = WebCatalog(self)
        self.web_discovery = WebDiscovery(self)
        self.score_identity = ScoreIdentity(self)

    def is_local(self, req):
        if req.get('fnos_gateway', False):
            return False
        return local_request(req.remote, req.host, req.headers, self.networks)

    def valid_session(self, value):
        try:
            payload, mac = value.rsplit('.', 1)
            expected = hmac.new(bytes.fromhex(self.cfg['session_key']), payload.encode(), hashlib.sha256).hexdigest()
            expiry = int(payload.split(':')[0])
            return hmac.compare_digest(mac, expected) and time.time() < expiry
        except (ValueError, AttributeError):
            return False

    def session(self):
        payload = str(int(time.time()) + 30 * 86400) + ':' + secrets.token_hex(16)
        return payload + '.' + hmac.new(bytes.fromhex(self.cfg['session_key']), payload.encode(), hashlib.sha256).hexdigest()

    def authed(self, req):
        return req.get('fnos_identity') is not None or self.is_local(req) or self.valid_session(req.cookies.get(COOKIE, ''))

    def is_admin_session(self, req):
        identity = req.get('fnos_identity')
        return bool(identity and identity.get('admin')) or self.valid_session(req.cookies.get(COOKIE, ''))

    async def fn(self, path, params=None):
        params = dict(params or {})
        for key in ('guid', 'trackGUID'):
            if key in params:
                params[key] = self.sources.upstream_guid(params[key])
        try:
            return await self.sources.music.call(path, params)
        except SourceError as e:
            raise web.HTTPBadGateway(text=e.message) from None

    async def refresh(self, force=False):
        # Metadata indexing runs independently of HTTP requests and playback.
        if force:
            await asyncio.gather(*(self.catalog.sync(k) for k in ('music', 'video')))

    async def music_rows(self):
        rows = {}
        page = 1
        first = None
        while True:
            d = await self.fn('track/list', {'page': page, 'pageSize': 500})
            items = d['list']
            if items and page > 1 and items[0]['guid'] == first:
                raise web.HTTPBadGateway(text='飞牛曲库分页异常')
            if page == 1 and items:
                first = items[0]['guid']
            for s in items:
                rows[self.sources.music_guid(s['guid'])] = {'title': s.get('title') or '未命名',
                    'artist': ' / '.join(a['name'] for a in s.get('artists', [])) or '未知歌手',
                    'album':s.get('album',{}).get('title') or s.get('album',{}).get('name') or '',
                    'genre': ' / '.join(a['name'] for a in s.get('genres', [])) or '音乐',
                    'language': s.get('language') if isinstance(s.get('language'), str) else '未分类',
                    'duration': s.get('duration', 0) / 1000,
                    'format': s.get('audioSpec', {}).get('format', ''), 'audio_only': True, 'media_kind': 'audio',
                    'coverId': s.get('coverId') or s.get('album', {}).get('coverId') or '',
                    'isCue': s.get('isCue') if type(s.get('isCue')) is bool else None,
                    'revision': str(s.get('updatedAt', 0))}
            if len(rows) >= d['total'] or not items:
                break
            page += 1
            if page > 10000:
                raise web.HTTPBadGateway(text='飞牛曲库超过索引上限')
        return rows

    async def video_rows(self):
        rows = await self.videos.scan()
        source = self.sources.video
        libraries = source.data.get('libraries', [])
        if not source.data.get('token') or not libraries:
            return rows
        generation = source.generation
        scope = source.data.get('scope', '')
        for library in libraries:
            seen = set()
            for page in range(1, 2001):
                data = await source.call('item/list', body={'ancestor_guid': library,
                    'tags': {'type': ['Video', 'Movie', 'Episode']}, 'sort_type': 'ASC',
                    'sort_column': 'title', 'page': page, 'page_size': 200})
                if source.generation != generation:
                    raise SourceError('STALE_SESSION', '影视来源已变更')
                if not isinstance(data, dict) or not isinstance(data.get('list'), list):
                    raise SourceError('INVALID_RESPONSE', '影视目录响应不完整，保留原曲库')
                items = data['list']
                total = data.get('total', data.get('total_count'))
                if total is not None and (type(total) is not int or total < 0):
                    raise SourceError('INVALID_RESPONSE', '影视目录数量不正确，保留原曲库')
                fresh = 0
                for item in items:
                    if not isinstance(item, dict) or not isinstance(item.get('guid'), str) or not item['guid']:
                        raise SourceError('INVALID_RESPONSE', '影视目录缺少曲目编号，保留原曲库')
                    item_guid = item['guid']
                    if item_guid in seen:
                        continue
                    seen.add(item_guid)
                    fresh += 1
                    if str(item.get('type', '')).lower() in ('directory', 'tv', 'season', 'folder'):
                        continue
                    title = item.get('title') or item.get('name') or '未命名视频'
                    artist = item.get('artist') or '飞牛影视'
                    rows['fnvideo:' + scope + ':' + item_guid] = {
                        'title': title, 'artist': artist, 'album': item.get('album') or '',
                        'genre': item.get('genre') or 'MV / 视频', 'language': item.get('language') or '未分类',
                        'duration': float(item.get('duration') or 0), 'format': item.get('format') or '',
                        'audio_only': False, 'media_kind': 'mv', 'provider': 'fnvideo',
                        'coverId': item.get('poster') or '', 'revision': str(item.get('updated_at') or item.get('updatedAt') or '0')}
                if items and fresh == 0:
                    raise SourceError('INVALID_RESPONSE', '影视目录分页重复，保留原曲库')
                if total is not None and len(seen) >= total:
                    break
                if not items or total is None and len(items) < 200:
                    if total is not None and len(seen) < total:
                        raise SourceError('INVALID_RESPONSE', '影视目录读取不完整，保留原曲库')
                    break
                if page == 2000:
                    raise SourceError('INVALID_RESPONSE', '影视目录过大，请缩小媒体库')
        return rows

    async def quark_rows(self):
        return await self.sources.quark.scan_rows()

    def song(self, sid):
        r = self.db.execute('SELECT * FROM songs WHERE id=?', (sid,)).fetchone()
        if not r:
            raise web.HTTPNotFound(text='歌曲不存在')
        return dict(json.loads(r['data']), id=r['id'], song_id=r['id'])

    def queue(self):
        rows = self.db.execute('SELECT * FROM queue ORDER BY COALESCE(position,id),id').fetchall()
        return [dict(self.song(r['song_id']), queue_id=r['id'], status='playing' if i == 0 else 'waiting') for i, r in enumerate(rows)]

    async def broadcast(self, value):
        for ws in list(self.sockets):
            if value.get('type') in ('queue', 'player_changed', 'progress', 'state') and not self.targets.receives_tv(ws):
                continue
            if not ws.closed:
                try:
                    if not self.authed(self.socket_requests[ws]):
                        await ws.close(code=1008, message=b'Login expired')
                        continue
                    await ws.send_json(value)
                except ConnectionError:
                    pass

    async def publish_queue(self):
        await self.broadcast({'type': 'queue', 'data': self.queue()})
        # This only schedules bounded tasks; expensive analysis never blocks point-song requests.
        try:
            await self.scores.prepare_queue()
        except Exception:
            logging.warning('Score preparation scheduling deferred; song selection is preserved')

    def player_message(self):
        return {'type': 'player_changed', 'activeDeviceId': self.player, 'activeDeviceName': self.player_name, 'locked': False}

    async def api(self, req):
        path = req.path
        if path.startswith('/api/v2/score-identity/'):
            return await self.score_identity.api(req)
        if path.startswith('/api/web/discovery/'):
            return await self.web_discovery.api(req)
        if path == '/api/web/context':
            if req.method != 'GET':
                raise web.HTTPMethodNotAllowed(req.method, ['GET'])
            return web.json_response(self.web_catalog.context(req), headers={'Cache-Control': 'no-store'})
        if path in ('/api/web/catalog/groups', '/api/web/catalog/songs'):
            if req.method != 'GET':
                raise web.HTTPMethodNotAllowed(req.method, ['GET'])
            return self.web_catalog.response(req)
        if path.startswith('/api/admin/scoring/'):
            if not self.is_admin_session(req):
                raise web.HTTPUnauthorized(text='修改评分任务需要登录应用管理账号')
            if req.method != 'POST':
                raise web.HTTPMethodNotAllowed(req.method, ['POST'])
            action = path.removeprefix('/api/admin/scoring/')
            if action not in ('pause', 'resume', 'retry', 'cancel'):
                raise web.HTTPNotFound()
            data = await req.json() if req.can_read_body else {}
            if not isinstance(data, dict):
                raise web.HTTPBadRequest(text='请求参数不正确')
            sid = data.get('songId', data.get('song_id'))
            if sid is not None and (type(sid) is not int or sid <= 0):
                raise web.HTTPBadRequest(text='歌曲编号无效')
            return web.json_response(await self.scores.control(action, sid), headers={'Cache-Control': 'no-store'})
        if path.startswith('/api/v2/score-cache/'):
            return await self.shared_scores.api(req)
        if path.startswith(('/api/cover/','/api/lyrics/','/api/pitch/','/api/score/','/api/accompaniment/')):
            sid = int(path.split('/')[3])
            row = self.db.execute('SELECT guid FROM songs WHERE id=?',(sid,)).fetchone()
            if row:
                if row[0].startswith('fnvideo:'):
                    self.video_item(row[0])
                elif row[0].startswith('quark:'):
                    self.sources.quark.resolve(row[0])
                elif not row[0].startswith('video:'):
                    self.sources.upstream_guid(row[0])
        if path.startswith('/api/v2/playback/') and req.method == 'GET':
            sid = int(path.rsplit('/', 1)[1])
            song = self.song(sid)
            guid = self.db.execute('SELECT guid FROM songs WHERE id=?', (sid,)).fetchone()[0]
            if guid.startswith('video:'):
                descriptor = await self.video_playback.descriptor(sid)
                tracks = descriptor.get('audioTracks') or []
                for index, track in enumerate(tracks):
                    track['streamIndex'] = track.get('index')
                    track['index'] = index
                    track['name'] = '音轨 ' + str(index + 1)
                if len(tracks) > 1:
                    # Browsers do not consistently expose embedded audio tracks.
                    # HLS renditions preserve selection without guessing roles.
                    descriptor.update(transport='hls', playUrl=f'/mv/{sid}/master.m3u8',
                        mimeType='application/x-mpegURL', fallbackReason='保留 MV 多音轨选择')
            elif guid.startswith('fnvideo:'):
                self.video_item(guid)
                descriptor = {'mediaKind': 'mv', 'transport': 'progressive', 'playUrl': f'/stream/{sid}',
                    'mimeType': None, 'canSeek': True, 'durationMs': int(float(song.get('duration') or 0) * 1000),
                    'audioTracks': [], 'fallbackReason': None, 'expiresAt': None}
            elif guid.startswith('quark:'):
                self.sources.quark.resolve(guid)
                accompaniment = (self.scores.folder(sid) / 'accompaniment.m4a').is_file()
                kind = song.get('media_kind', 'audio')
                descriptor = {'mediaKind': kind, 'transport': 'progressive', 'playUrl': f'/stream/{sid}',
                    'mimeType': None, 'canSeek': True, 'durationMs': int(float(song.get('duration') or 0) * 1000),
                    'fallbackUrl': f'/hls/{sid}/master.m3u8' if kind == 'audio' else None, 'audioTracks': [],
                    'accompanimentAvailable': accompaniment,
                    'accompanimentUrl': f'/api/accompaniment/{sid}' if accompaniment else None,
                    'fallbackReason': None, 'expiresAt': None}
            else:
                self.sources.upstream_guid(guid)
                accompaniment = (self.scores.folder(sid) / 'accompaniment.m4a').is_file()
                descriptor = {'mediaKind': 'audio', 'transport': 'progressive', 'playUrl': f'/stream/{sid}',
                    'mimeType': None, 'canSeek': True, 'durationMs': int(float(song.get('duration') or 0) * 1000),
                    'fallbackUrl': f'/hls/{sid}/master.m3u8', 'audioTracks': [],
                    'accompanimentAvailable': accompaniment,
                    'accompanimentUrl': f'/api/accompaniment/{sid}' if accompaniment else None,
                    'fallbackReason': None, 'expiresAt': None}
            for key in ('playUrl', 'fallbackUrl', 'accompanimentUrl'):
                if descriptor.get(key):
                    descriptor[key] = scoped_url(req, descriptor[key])
            descriptor['scoreIdentity'] = {'status': 'pending',
                'endpoint': scoped_url(req, f'/api/v2/score-identity/{sid}')}
            return web.json_response(descriptor)
        if path.startswith('/api/v2/sources'):
            return await self.sources.api(req)
        if path.startswith('/api/sources/kugou/'):
            action=path.rsplit('/',1)[1]
            allowed=['GET'] if action=='status' else ['POST']
            if req.method not in allowed:raise web.HTTPMethodNotAllowed(req.method,allowed)
            return await self.online_tracks.login(action)
        allowed = ['GET']
        if path == '/api/tv-auth/login' or path == '/api/queue/next' or path.endswith('/top'):
            allowed = ['POST']
        elif path == '/api/queue':
            allowed = ['GET', 'POST']
        elif path.startswith('/api/queue/'):
            allowed = ['DELETE']
        elif path.startswith('/api/favorites/'):
            allowed = ['POST', 'DELETE']
        if req.method not in allowed:
            raise web.HTTPMethodNotAllowed(req.method, allowed)
        if path == '/api/app/status':
            sources = [{'id': source.kind, 'state': source.state}
                       for source in (self.sources.music, self.sources.video, self.sources.quark)]
            return web.json_response({'ok': True, 'appId': 'feiniu-karaoke',
                'deployment': 'fnos' if self.cfg.get('gateway_socket') else 'standalone',
                'basePath': req.get('app_base_path', ''), 'gateway': req.get('fnos_gateway', False),
                'gatewaySso': bool(self.cfg.get('gateway_sso', False)),
                'gatewayAuthenticated': req.get('fnos_identity') is not None,
                'admin': self.is_admin_session(req),
                'sourceSetupRequired': not any(source.data.get('token') for source in (self.sources.music, self.sources.video))
                    and not self.sources.quark.authenticated and not bool(self.videos.roots),
                'sources': sources, 'features': {'mobile': True, 'independentPlayback': True, 'sourceManagement': True}},
                headers={'Cache-Control': 'no-store'})
        if path == '/api/score-library':
            await self.refresh()
            return web.json_response(await self.scores.library_status(),headers={'Cache-Control':'no-store'})
        if path.startswith('/api/score/'):
            sid = int(path.rsplit('/',1)[1])
            self.song(sid)
            if self.scores.cached(self.scores.folder(sid)) is not None:
                # An existing score must not wait for a new media fingerprint,
                # which deliberately yields for the entire ongoing playback.
                shared = await self.shared_scores.for_song(sid, allow_fingerprint=False)
                if shared is not None:return web.json_response(shared,headers={'Cache-Control':'no-store'})
                return await self.scores.get(sid)
            shared = await self.shared_scores.for_song(sid)
            if shared is not None:return web.json_response(shared,headers={'Cache-Control':'no-store'})
            return await self.scores.get(sid)
        if path.startswith('/api/accompaniment/'):
            sid = int(path.rsplit('/',1)[1])
            self.song(sid)
            folder = self.scores.folder(sid)
            if not (folder/'accompaniment.m4a').is_file():
                raise web.HTTPNotFound(text='伴奏尚未准备好')
            return web.FileResponse(folder/'accompaniment.m4a',headers={'Content-Type':'audio/mp4'})
        if path.startswith('/api/cover/'):
            sid = int(path.rsplit('/',1)[1])
            song = self.song(sid)
            guid = self.db.execute('SELECT guid FROM songs WHERE id=?', (sid,)).fetchone()[0]
            if guid.startswith('quark:'):
                raise web.HTTPNotFound(text='云盘曲目没有提供封面')
            if guid.startswith('fnvideo:'):
                poster = song.get('coverId')
                if not isinstance(poster, str) or not poster or ':' in poster or '..' in poster or '\\' in poster:
                    raise web.HTTPNotFound(text='暂无视频封面')
                address = self.sources.video.data['url'].rstrip('/') + '/api/v1/sys/img/' + quote(poster.lstrip('/'), safe='/')
                from fn_video import video_signature
                headers = {'Authorization': self.sources.video.data['token'],
                           'authx': video_signature(urlsplit(address).path, 'GET', params={'w': 400})}
                async with self.http.get(address, params={'w': 400}, headers=headers, allow_redirects=False) as upstream:
                    kind = upstream.headers.get('Content-Type', '').split(';')[0]
                    if upstream.status != 200 or kind not in ('image/jpeg', 'image/png', 'image/webp'):
                        raise web.HTTPNotFound(text='暂无视频封面')
                    data = bytearray()
                    async for chunk in upstream.content.iter_chunked(65536):
                        data.extend(chunk)
                        if len(data) > 4 * 1024 * 1024:
                            raise web.HTTPBadGateway(text='封面过大')
                    return web.Response(body=bytes(data), content_type=kind, headers={'Cache-Control': 'private, max-age=3600'})
            if song.get('media_kind') == 'mv':
                poster = await self.videos.cover(guid)
                if poster is None: raise web.HTTPNotFound(text='暂无视频封面')
                return web.FileResponse(poster, headers={'Cache-Control': 'private, max-age=3600'})
            cover = song.get('coverId')
            if not cover:
                row = self.db.execute('SELECT guid FROM songs WHERE id=?',(sid,)).fetchone()
                metadata = await self.fn('track/metadata',{'guid':row['guid']})
                cover = metadata.get('track',{}).get('coverId')
            if not cover:
                raise web.HTTPNotFound(text='暂无专辑封面')
            url = self.cfg['music_url'].rstrip('/')+'/api/v1/static/cover'
            async with self.http.get(url,params={'coverId':cover,'size':512},
                    headers={'Cookie':'music-token='+self.cfg['music_token']},allow_redirects=False) as r:
                kind=r.headers.get('Content-Type','').split(';')[0]
                if r.status!=200 or kind not in ('image/jpeg','image/png','image/webp'):
                    raise web.HTTPNotFound(text='暂无专辑封面')
                chunks=[];size=0
                async for chunk in r.content.iter_chunked(65536):
                    size+=len(chunk)
                    if size>4*1024*1024:raise web.HTTPBadGateway(text='封面过大')
                    chunks.append(chunk)
                return web.Response(body=b''.join(chunks),content_type=kind,headers={'Cache-Control':'private, max-age=3600'})
        if path.startswith('/api/pitch/'):
            sid = int(path.rsplit('/', 1)[1])
            guid, folder = self.audio_cache(sid)
            async with self.pitch_lock:
                cached = folder/'pitch-v1.json'
                if cached.is_file():
                    return web.FileResponse(cached)
                if not (folder/'complete').exists():
                    task = self.transcodes.get(str(folder))
                    if task is None or task.done():
                        task = asyncio.create_task(self.transcode(guid, folder))
                        self.transcodes[str(folder)] = task
                    await asyncio.wait_for(asyncio.shield(task), 180)
                proc = await asyncio.create_subprocess_exec('/usr/bin/ffmpeg', '-v', 'error', '-i', str(folder/'index.m3u8'),
                    '-t', '600', '-vn', '-ac', '1', '-ar', '8000', '-f', 'f32le', 'pipe:1',
                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
                try:
                    pcm, _ = await asyncio.wait_for(proc.communicate(), 60)
                    if proc.returncode != 0:
                        raise web.HTTPBadGateway(text='参考音高分析失败')
                    value = await asyncio.to_thread(reference_pitch, pcm)
                    cached.write_text(json.dumps(value), encoding='utf-8')
                    return web.json_response(value)
                finally:
                    if proc.returncode is None:
                        proc.kill(); await proc.wait()
        if path.startswith('/api/lyrics/'):
            sid = int(path.rsplit('/', 1)[1])
            row = self.db.execute('SELECT guid FROM songs WHERE id=?', (sid,)).fetchone()
            if not row:
                raise web.HTTPNotFound()
            if row['guid'].startswith('quark:'):
                song = self.song(sid)
                content = await self.sources.quark.lyrics(row['guid'], song['quark_lyric']) if song.get('quark_lyric') else ''
                return web.json_response({'content': content, 'synced': bool(content), 'offset': 0, 'source': '夸克同目录 LRC'})
            if row['guid'].startswith('fnvideo:'):
                return web.json_response({'content': '', 'synced': False, 'offset': 0, 'source': '飞牛影视'})
            if row['guid'].startswith('video:'):
                source = self.videos.path(row['guid'])
                lrc = source.with_suffix('.lrc') if source else None
                content = ''
                if lrc and self.videos.allowed(lrc) and lrc.is_file() and lrc.stat().st_size < 1024*1024:
                    content = await asyncio.to_thread(lrc.read_text, encoding='utf-8-sig', errors='replace')
                return web.json_response({'content':content,'synced':bool(content),'offset':0,'source':'本地视频字幕'})
            cached = self.lyrics_cache.get(row['guid'])
            if cached and time.time() - cached[0] < 300:
                return web.json_response(cached[1])
            data = await self.fn('lyric/list', {'trackGUID': row['guid']})
            items = data.get('list') or []
            preferred = data.get('preferred')
            chosen = next((x for x in items if x.get('guid') == preferred), None)
            chosen = chosen or next((x for x in items if x.get('isLRC') and x.get('content')), None)
            chosen = chosen or (items[0] if items else {})
            result = {'content': chosen.get('content') or '', 'synced': bool(chosen.get('isLRC')),
                      'offset': chosen.get('offset') or 0, 'source': '飞牛音乐'}
            result = await self.online_lyrics.get(sid,result)
            self.lyrics_cache[row['guid']] = (time.time(), result)
            return web.json_response(result)
        if path == '/api/tv-auth/session':
            return web.json_response({'authed': self.authed(req), 'lan': self.is_local(req), 'source': 'fnOS Music',
                'admin': self.is_admin_session(req), 'gatewayAuthenticated': req.get('fnos_identity') is not None,
                **issue_gateway_proof(req, self.cfg)},
                headers={'Cache-Control':'no-store'})
        if path == '/api/tv-auth/login':
            now = time.time()
            recent = [t for t in self.failures.get(req.remote, []) if now - t < 300]
            if len(recent) >= 8:
                raise web.HTTPTooManyRequests(text='请稍后重试')
            d = await req.json()
            digest = hashlib.pbkdf2_hmac('sha256', str(d.get('password', '')).encode(), bytes.fromhex(self.cfg['password_salt']), 200000).hex()
            if d.get('username') != self.cfg['username'] or not hmac.compare_digest(digest, self.cfg['password_hash']):
                self.failures[req.remote] = recent + [now]
                raise web.HTTPUnauthorized(text='账号或密码错误')
            self.failures.pop(req.remote, None)
            r = web.json_response({'ok': True})
            r.set_cookie(COOKIE, self.session(), max_age=30 * 86400, httponly=True,
                         samesite='Strict', secure=req.secure, path=req.get('app_base_path', '') or '/')
            return r
        if path == '/api/v2/health':
            return web.json_response({'ok': True, 'catalogRevision': self.catalog.revision, 'sources': self.catalog.status, 'videoScan': self.videos.progress})
        if path == '/api/stats':
            await self.refresh()
            videos = self.db.execute("SELECT count(*) FROM current_guids WHERE guid LIKE 'video:%' OR guid LIKE 'fnvideo:%'").fetchone()[0]
            return web.json_response({'songs': self.db.execute('SELECT count(*) FROM current_guids').fetchone()[0], 'source': 'fnOS Music + local video', 'audioOnly': videos == 0, 'videos': videos, 'videoPlayback': True, 'catalogRevision': self.catalog.revision, 'catalogToken': self.catalog.queries.token, 'sources': self.catalog.status})
        if path in ('/api/songs', '/api/artists', '/api/charts'):
            # The background sync owns network/directory discovery. List requests
            # only read the last complete local snapshot and decode their page.
            return self.catalog.queries.response(req, self.catalog.revision)
        if path == '/api/queue':
            if req.method == 'POST':
                d = await req.json()
                sid = int(d['song_id'])
                self.song(sid)
                with self.db:
                    self.db.execute('INSERT INTO queue(song_id,position) SELECT ?,COALESCE(MAX(COALESCE(position,id)),0)+1 FROM queue', (sid,))
                await self.publish_queue()
            return web.json_response(self.queue())
        if path == '/api/queue/next':
            d = await req.json()
            row = self.db.execute('SELECT * FROM queue ORDER BY COALESCE(position,id),id LIMIT 1').fetchone()
            if row and (not d.get('expected_queue_id') or int(d['expected_queue_id']) == row['id']):
                with self.db:
                    self.db.execute('INSERT INTO history(song_id,at) VALUES(?,?)', (row['song_id'], time.time()))
                    self.db.execute('DELETE FROM queue WHERE id=?', (row['id'],))
                await self.publish_queue()
            return web.json_response({'ok': True})
        if path.startswith('/api/queue/'):
            bits = path.strip('/').split('/')
            qid = int(bits[2])
            if len(bits) == 4 and bits[3] == 'top':
                # Position is independent of queue identity; preserve IDs when moving.
                rows = self.queue()
                waiting = [s for s in rows[1:] if s['queue_id'] == qid]
                if waiting and len(rows) > 2:
                    self.order_override = [rows[0]['queue_id'], qid] + [s['queue_id'] for s in rows[1:] if s['queue_id'] != qid]
                    with self.db:
                        for pos, ident in enumerate(self.order_override):
                            self.db.execute('UPDATE queue SET position=? WHERE id=?', (pos, ident))
            elif req.method == 'DELETE':
                with self.db:
                    self.db.execute('DELETE FROM queue WHERE id=?', (qid,))
            else:
                raise web.HTTPMethodNotAllowed(req.method, ['DELETE', 'POST'])
            await self.publish_queue()
            return web.json_response({'ok': True})
        if path == '/api/history':
            return web.json_response([self.song(r[0]) for r in self.db.execute('SELECT song_id FROM history ORDER BY id DESC LIMIT 100')])
        if path == '/api/favorites':
            return web.json_response([self.song(r[0]) for r in self.db.execute('SELECT song_id FROM favorites WHERE device=?', (req.query.get('device', ''),))])
        if path.startswith('/api/favorites/'):
            sid = int(path.rsplit('/', 1)[1]); self.song(sid)
            d = await req.json() if req.method == 'POST' else req.query
            device = d.get('device', '')
            with self.db:
                if req.method == 'POST':
                    self.db.execute('INSERT OR IGNORE INTO favorites VALUES(?,?)', (device, sid))
                elif req.method == 'DELETE':
                    self.db.execute('DELETE FROM favorites WHERE device=? AND song_id=?', (device, sid))
            return web.json_response({'ok': True})
        raise web.HTTPNotFound()

    def video_item(self, guid):
        if not self.sources.video.data.get('token'):
            raise web.HTTPForbidden(text='影视来源已退出登录')
        parts = guid.split(':', 2)
        if len(parts) != 3 or parts[1] != self.sources.video.data.get('scope') or not parts[2]:
            raise web.HTTPForbidden(text='影视来源已变更，请更新曲库')
        return parts[2]

    async def video_media(self, guid):
        item = self.video_item(guid)
        source = self.sources.video
        generation, source_data = source.generation, dict(source.data)
        try:
            info = await source.call('play/info', body={'item_guid': item})
        except SourceError as error:
            raise web.HTTPBadGateway(text=error.message) from None
        if generation != source.generation:
            raise web.HTTPForbidden(text='影视来源已变更，请更新曲库')
        source_data = dict(source.data)  # Automatic reauthentication may rotate the token.
        media = info.get('media_guid') if isinstance(info, dict) else None
        if not isinstance(media, str) or not media or len(media) > 300 or any(c in media for c in '/\\\r\n'):
            raise web.HTTPBadGateway(text='影视文件暂不可播放')
        address = source_data['url'].rstrip('/') + '/api/v1/media/range/' + quote(media, safe='')
        from fn_video import video_signature
        token = source_data['token']
        headers = {'Authorization': token, 'Cookie': 'Trim-MC-token=' + token,
                   'authx': video_signature(urlsplit(address).path, 'GET'), 'Accept-Encoding': 'identity'}
        return address, headers

    async def stream(self, req):
        sid = int(req.match_info['sid'])
        row = self.db.execute('SELECT guid FROM songs WHERE id=?', (sid,)).fetchone()
        if not row:
            raise web.HTTPNotFound()
        if row[0].startswith('video:'):
            path = self.videos.path(row[0])
            if path is None: raise web.HTTPNotFound(text='视频文件已移动或不可访问')
            return web.FileResponse(path, headers={'Cache-Control':'private, no-store'})
        if row[0].startswith('fnvideo:'):
            address, headers = await self.video_media(row[0])
            if 'Range' in req.headers:
                headers['Range'] = req.headers['Range']
            async with self.http.get(address, headers=headers, allow_redirects=False, auto_decompress=False,
                    timeout=ClientTimeout(total=None, sock_read=60)) as upstream:
                return await self.proxy_stream(req, upstream)
        if row[0].startswith('quark:'):
            source = self.sources.quark
            generation = source.generation
            async with source.media_response(row[0], req.headers.get('Range')) as upstream:
                return await self.proxy_stream(req, upstream, lambda: source.generation == generation)
        headers = {'Cookie': 'music-token=' + self.cfg['music_token'], 'Accept-Encoding': 'identity'}
        if 'Range' in req.headers:
            headers['Range'] = req.headers['Range']
        async with self.http.get(self.cfg['music_url'].rstrip('/') + '/api/v1/track/stream', params={'guid': self.sources.upstream_guid(row[0])},
                                 headers=headers, allow_redirects=False, auto_decompress=False, timeout=ClientTimeout(total=None, sock_read=60)) as upstream:
            return await self.proxy_stream(req, upstream)

    async def proxy_stream(self, req, upstream, still_current=None):
        if upstream.status not in (200, 206, 416):
            raise web.HTTPBadGateway(text='飞牛媒体流暂不可用')
        response = web.StreamResponse(status=upstream.status, headers={k: v for k, v in upstream.headers.items()
            if k.lower() in ('content-type', 'content-length', 'content-range', 'accept-ranges')})
        response.headers['Cache-Control'] = 'private, no-store'
        await response.prepare(req)
        if req.method != 'HEAD':
            try:
                async for chunk in upstream.content.iter_chunked(128 * 1024):
                    if still_current and not still_current():
                        break
                    await response.write(chunk)
            except (ConnectionResetError, asyncio.CancelledError):
                pass
        return response

    def audio_cache(self, sid):
        row = self.db.execute('SELECT guid,data FROM songs WHERE id=?', (sid,)).fetchone()
        if not row:
            raise web.HTTPNotFound()
        if row['guid'].startswith('fnvideo:'):
            self.video_item(row['guid'])
        elif row['guid'].startswith('quark:'):
            self.sources.quark.resolve(row['guid'])
        elif not row['guid'].startswith('video:'):
            self.sources.upstream_guid(row['guid'])
        # Hash the GUID + metadata revision; no user-controlled filesystem paths.
        key = hashlib.sha256((row['guid'] + ':' + json.loads(row['data']).get('revision', '0')).encode()).hexdigest()
        return row['guid'], self.cache / key

    async def transcode(self, guid, folder):
        async with self.transcode_slots:
            folder.mkdir(parents=True, exist_ok=True)
            proc = None
            try:
                local = self.videos.path(guid) if guid.startswith('video:') else None
                if guid.startswith('video:') and local is None:
                    raise RuntimeError('Video source unavailable')
                proc = await asyncio.create_subprocess_exec(
                    '/usr/bin/ffmpeg', '-hide_banner', '-loglevel', 'error', '-y',
                    '-i', str(local) if local else 'pipe:0', '-vn', '-c:a', 'aac', '-b:a', '256k', '-ac', '2', '-ar', '48000',
                    '-f', 'hls', '-hls_time', '4', '-hls_list_size', '0', '-hls_playlist_type', 'event',
                    '-hls_flags', 'temp_file', '-hls_segment_filename', str(folder/'segment%05d.ts'), str(folder/'index.m3u8'),
                    stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
                if local is None:
                    await self.feed_audio(guid, proc)
                proc.stdin.close()
                code = await asyncio.wait_for(proc.wait(), 7200 if local else 120)
                if code != 0:
                    raise RuntimeError('Audio conversion failed')
                (folder/'complete').touch()
                self.prune_cache(folder)
            except (Exception, asyncio.CancelledError):
                if proc and proc.returncode is None:
                    proc.kill(); await proc.wait()
                raise

    async def feed_audio(self, guid, proc, before_chunk=None):
        if before_chunk is not None:
            await before_chunk()
        if guid.startswith('quark:'):
            source = self.sources.quark
            generation = source.generation
            async with source.media_response(guid) as upstream:
                if upstream.status not in (200, 206):
                    raise SourceError('SOURCE_OFFLINE', '夸克音频暂不可用')
                async for data in upstream.content.iter_chunked(128 * 1024):
                    if generation != source.generation:
                        raise SourceError('STALE_SESSION', '夸克账号已变更')
                    if before_chunk is not None:
                        await before_chunk()
                    proc.stdin.write(data)
                    await proc.stdin.drain()
            return
        if guid.startswith('fnvideo:'):
            address, headers = await self.video_media(guid)
            params = None
        else:
            address = self.cfg['music_url'].rstrip('/') + '/api/v1/track/stream'
            params = {'guid': self.sources.upstream_guid(guid)}
            headers = {'Cookie': 'music-token=' + self.cfg['music_token'], 'Accept-Encoding': 'identity'}
        async with self.http.get(address, params=params, headers=headers,
                                         allow_redirects=False, timeout=ClientTimeout(total=None, sock_read=60)) as r:
            if r.status not in (200,206):
                raise RuntimeError('Upstream audio unavailable')
            async for data in r.content.iter_chunked(128*1024):
                if before_chunk is not None:
                    await before_chunk()
                proc.stdin.write(data)
                await proc.stdin.drain()

    def prune_cache(self, current):
        # Remove only completed cache directories created by this service, never source media.
        folders = [p for p in self.cache.iterdir() if p.is_dir() and not p.is_symlink()
                   and len(p.name) == 64 and all(c in '0123456789abcdef' for c in p.name)]
        sizes = {p: sum(f.stat().st_size for f in p.iterdir() if f.is_file()) for p in folders}
        total = sum(sizes.values())
        for p in sorted(folders, key=lambda p:p.stat().st_mtime):
            if total <= 512 * 1024 * 1024:
                break
            task = self.transcodes.get(str(p))
            # Keep recently accessed HLS sessions for seeks and playback.
            if p == current or time.time() - p.stat().st_mtime < 3600 or (task and not task.done()):
                continue
            if p.resolve().parent == self.cache and (p/'complete').exists():
                shutil.rmtree(p)
                total -= sizes[p]
                self.transcodes.pop(str(p), None)

    async def hls(self, req):
        sid = int(req.match_info['sid'])
        guid, folder = self.audio_cache(sid)
        name = req.match_info['name']
        if name == 'master.m3u8':
            key = str(folder)
            task = self.transcodes.get(key)
            if not (folder/'complete').exists() and (task is None or task.done()):
                if folder.exists():
                    for old in folder.iterdir():
                        if old.is_file() and not old.is_symlink():
                            old.unlink()
                task = asyncio.create_task(self.transcode(guid, folder))
                self.transcodes[key] = task
                # Consume failures to avoid logging credential-bearing request representations.
                task.add_done_callback(lambda t: t.exception() if not t.cancelled() else None)
            for _ in range(150):
                if (folder/'index.m3u8').exists() and (folder/'segment00000.ts').exists():
                    os.utime(folder, None)
                    response = web.FileResponse(folder/'index.m3u8', headers={'Content-Type':'application/vnd.apple.mpegurl', 'Cache-Control':'no-store'})
                    return response
                if task and task.done() and task.exception():
                    raise web.HTTPBadGateway(text='音频兼容转码失败')
                await asyncio.sleep(.2)
            raise web.HTTPServiceUnavailable(text='音频正在准备，请稍后重试')
        # Route regex only permits ffmpeg-generated segment names.
        file = folder/name
        if not file.is_file():
            raise web.HTTPNotFound()
        return web.FileResponse(file, headers={'Content-Type':'video/mp2t','Cache-Control':'private, max-age=3600'})

    async def websocket(self, req):
        # The proof authenticates only the handshake. Remove it before aiohttp
        # protocol negotiation so unsupported-protocol diagnostics cannot log it.
        offered = req.headers.get('Sec-WebSocket-Protocol', '').split(',')
        if any(value.strip().startswith('fnos-proof.') for value in offered):
            headers = req.headers.copy()
            clean = [value.strip() for value in offered if not value.strip().startswith('fnos-proof.')]
            if clean:
                headers['Sec-WebSocket-Protocol'] = ', '.join(clean)
            else:
                headers.pop('Sec-WebSocket-Protocol', None)
            req = req.clone(headers=headers)
        ws = web.WebSocketResponse(heartbeat=20, max_msg_size=65536, protocols=('feiniu-karaoke',))
        await ws.prepare(req)
        self.sockets[ws] = ''
        self.socket_requests[ws] = req
        await ws.send_json({'type': 'queue', 'data': self.queue()})
        await ws.send_json(self.player_message())
        await ws.send_json(self.targets.list_message())
        try:
            async for msg in ws:
                if msg.type != WSMsgType.TEXT:
                    continue
                if not self.authed(req):
                    await ws.close(code=1008, message=b'Login expired'); break
                try:
                    d = json.loads(msg.data)
                    kind = d.get('type')
                    if await self.targets.receive(ws, d):
                        if (kind == 'phone_state' and ws in self.targets.phones and
                                isinstance(d.get('queue'), list) and isinstance(d.get('progress'), dict)):
                            self.scores.note_playback(dict(d['progress'], _playbackDevice=self.targets.phones[ws]['id']))
                        continue
                    if kind in ('role_announce', 'player_claim'):
                        device = str(d.get('deviceId', ''))[:128]
                        if not device:
                            continue
                        self.sockets[ws] = device
                        await self.targets.announce(ws, d, device)
                        if kind == 'player_claim':
                            self.player = device; self.player_name = str(d.get('deviceName', '电视'))[:80]
                            await ws.send_json({'type': 'role_ack', 'granted': True})
                        elif d.get('role') == 'controller' and self.player == device:
                            self.player = None; self.player_name = ''
                        await self.broadcast(self.player_message())
                    elif kind == 'control':
                        for player_ws, device in list(self.sockets.items()):
                            if device == self.player:
                                await player_ws.send_json(d)
                    elif kind in ('progress', 'state') and self.sockets[ws] == self.player:
                        self.scores.note_playback(dict(d, _playbackDevice=self.player))
                        await self.broadcast(d)
                except (ValueError, TypeError, ConnectionError):
                    continue
        finally:
            device = self.sockets.pop(ws, '')
            self.socket_requests.pop(ws, None)
            await self.targets.remove(ws)
            if self.player == device and device not in self.sockets.values():
                self.player = None; self.player_name = ''
                await self.broadcast(self.player_message())
        return ws

    async def start(self, app):
        self.http = ClientSession(timeout=ClientTimeout(total=30))
        self.scores.start()
        self.catalog.start()
        # Cache warmup is awaited by first catalog request; no stale partial lists.

    async def shutdown(self, app):
        # Close upgraded connections before aiohttp waits for HTTP handlers.
        await asyncio.gather(*(ws.close(code=1001, message=b'Service stopping')
                               for ws in list(self.sockets)), return_exceptions=True)

    async def stop(self, app):
        await self.score_identity.close()
        await self.sources.quark.close()
        await self.catalog.close()
        await self.video_playback.close()
        for ws in list(self.sockets):
            await ws.close()
        await self.shared_scores.close()
        await self.scores.close()
        await self.online_tracks.close()
        await self.online_lyrics.close()
        for task in self.transcodes.values():
            task.cancel()
        await asyncio.gather(*self.transcodes.values(), return_exceptions=True)
        await self.http.close()
        self.db.close()


def create_app(config, state):
    prefix = base_path(config)
    bridge = Bridge(config, state)
    # Queue positions are separate from permanent unique IDs.
    if 'position' not in [r[1] for r in bridge.db.execute('PRAGMA table_info(queue)')]:
        bridge.db.execute('ALTER TABLE queue ADD COLUMN position INTEGER')
        bridge.db.commit()

    @web.middleware
    async def auth(req, handler):
        try:
            # Browser module GETs include Origin but cannot attach our gateway
            # proof. These assets are already public; player_asset still checks
            # its file allowlist/traversal rules and emits no CORS permission.
            public_asset = req.method in ('GET', 'HEAD') and req.match_info.route.handler is player_asset
            if (not public_asset and req.headers.get('Origin') and urlsplit(req.headers['Origin']).netloc != req.host
                    and not valid_gateway_origin_proof(req, config)):
                raise web.HTTPForbidden(text='来源不匹配')
            public = req.path in ('/api/tv-auth/session', '/api/tv-auth/login', '/m', '/', '/sing', '/remote', '/sources', '/quark-sources') or req.path.startswith('/player-assets/')
            if not public and not bridge.authed(req):
                raise web.HTTPUnauthorized(text='外部访问请先登录')
            return await handler(req)
        except web.HTTPException as exc:
            return web.json_response({'error': exc.text}, status=exc.status)
        except SourceError as exc:
            return web.json_response({'code': exc.code, 'error': exc.message}, status=403 if exc.code in ('AUTH_REQUIRED', 'STALE_SESSION') else 502)
        except (ValueError, KeyError, TypeError):
            return web.json_response({'error': '请求参数不正确'}, status=400)
        except Exception:
            logging.exception('Request failed: %s', req.path)
            return web.json_response({'error': '服务暂不可用'}, status=503)

    app = web.Application(middlewares=[gateway_middleware(config), auth], client_max_size=65536)
    app['bridge'] = bridge
    async def mobile(req):
        return web.FileResponse(Path(__file__).with_name('singing.html'), headers={'Cache-Control': 'no-store'})
    async def remote(req):
        return web.FileResponse(Path(__file__).with_name('mobile.html'), headers={'Cache-Control': 'no-store'})
    async def sources(req):
        return web.FileResponse(Path(__file__).with_name('sources.html'),headers={'Cache-Control':'no-store','Referrer-Policy':'no-referrer'})
    async def quark_sources(req):
        return web.FileResponse(Path(__file__).with_name('quark_sources.html'), headers={'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer'})
    for root in (('', prefix) if prefix else ('',)):
        app.router.add_route('*', root + '/api/{tail:.*}', bridge.api)
        app.router.add_get(root + '/stream/{sid:\\d+}', bridge.stream)
        app.router.add_get(root + '/hls/{sid:\\d+}/{name:master.m3u8|segment[0-9]{5,8}\\.ts}', bridge.hls)
        app.router.add_get(root + '/mv/{sid:\\d+}/{name:master\\.m3u8|index_(?:video|audio[0-9]+)\\.m3u8|segment_(?:video|audio[0-9]+)_[0-9]{5,8}\\.ts}', bridge.video_playback.hls)
        app.router.add_get(root + '/ws', bridge.websocket)
        app.router.add_get(root + '/player-assets/{path:.*}', player_asset)
        app.router.add_get(root + '/sing', mobile)
        app.router.add_get(root + '/remote', remote)
        app.router.add_get(root + '/m', mobile)
        app.router.add_get(root + '/', mobile)
        app.router.add_get(root + '/sources', sources)
        app.router.add_get(root + '/quark-sources', quark_sources)
    if prefix:
        app.router.add_get(prefix, mobile)
    app.on_startup.append(bridge.start)
    app.on_shutdown.append(bridge.shutdown)
    app.on_cleanup.append(bridge.stop)
    return app


if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
    os.umask(0o077)
    cfg = json.loads(Path(os.environ.get('MAIDONG_CONFIG', 'config.json')).read_text())
    asyncio.run(serve(create_app(cfg, cfg.get('state', 'state.db')), cfg))
