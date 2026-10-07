"""On-demand, account-scoped identities of authorized original media files.

Playback streams, names, catalog GUIDs and HLS renditions are never identities.
No original media is copied to the cache or sent to the scoring service.
"""
import asyncio
from collections import OrderedDict
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import threading
import time

from aiohttp import web, ClientError, ClientTimeout


CHUNK_BYTES = 1024 * 1024
MAX_MEDIA_BYTES = 4 * 1024**3
MAX_JOBS = 1
CACHE_TTL = 30
POLL_IDLE_SECONDS = 15
JOB_TIMEOUT = 120
PROBE_PREFIX_BYTES = 8 * 1024 * 1024
MUSIC_ASSET_ROOT = Path('/var/apps/trim.music/target/static/assets')
MUSIC_MANIFEST = Path('/var/apps/trim.music/manifest')
# Audited official direct-stream resolver and API routes from the installed
# fnMusic build. Only route facts and digests are retained, never its source.
PROVEN_MUSIC_ASSETS = {
    '1bc04b5291c26a46d918139138b992d2-D_KTkUJS.js': '4c6f7acd10bf9a637968e775dfbdb6a50acbb44aa65851184d561b3d4bf51a14',
    'fd1fcd61d83c0244c83762ba7832daad-DHF9K-B9.js': '54fe4eb652338bde0a3837ec0443bb57c32c6d7976c2fdca19380567a786397d',
    '5e884898da28047151d0e56f8dc62927-B563oObE.js': '546d1ba9de6d28692de8d53c56fc2b308b0e4518cbb4d271231e8cb305915763',
}


def audio_descriptor(probe):
    """Audio ordinals, never ffprobe's container/global stream indexes."""
    streams = probe.get('streams') if isinstance(probe, dict) else None
    if not isinstance(streams, list) or len(streams) > 128:
        raise ValueError('Invalid media metadata')
    audio = [s for s in streams if isinstance(s, dict) and s.get('codec_type') == 'audio']
    if not 1 <= len(audio) <= 64:
        raise ValueError('No supported audio track')
    tracks = []
    for ordinal, stream in enumerate(audio):
        tags = stream.get('tags') if isinstance(stream.get('tags'), dict) else {}
        title = str(tags.get('title', ''))[:128]
        value = title.lower()
        backing = any(word in value for word in ('no vocal', '伴奏', 'instrumental', 'karaoke', '无原唱'))
        original = not backing and any(word in value for word in ('原唱', 'original', 'vocal'))
        # Metadata is untrusted; do not expose path/URL-shaped track labels.
        label = '' if any(c in title for c in '/\\:') else ''.join(c for c in title if ord(c) >= 32)
        tracks.append({'audioTrack': ordinal, 'title': label,
                       'role': 'accompaniment' if backing else 'original' if original else 'unknown'})
    originals = [t['audioTrack'] for t in tracks if t['role'] == 'original']
    if len(originals) == 1:
        chosen, method = originals[0], 'explicit-original'
    elif len(audio) == 1 and tracks[0]['role'] != 'accompaniment':
        chosen, method = 0, 'single-audio'
    else:
        chosen, method = None, 'unknown'
    return {'audioTracks': tracks, 'originalAudioTrack': chosen, 'selectionMethod': method}


def stamp_version(info):
    # Windows stat/fstat expose different creation-time semantics. NAS/Linux
    # ctime is a change stamp; retain it there along with inode/mtime/size.
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns,
            info.st_ctime_ns if os.name != 'nt' else 0)


def file_version(path):
    info = path.stat()
    if not stat.S_ISREG(info.st_mode):
        raise ValueError('Not regular media')
    return stamp_version(info)


def hash_original(path, expected, cancelled):
    """Bounded streaming read; cancellation never leaves a media snapshot."""
    flags = os.O_RDONLY | getattr(os, 'O_BINARY', 0) | getattr(os, 'O_NOFOLLOW', 0)
    fd = os.open(path, flags)
    try:
        stamp = os.fstat(fd)
        actual = stamp_version(stamp)
        if not stat.S_ISREG(stamp.st_mode) or actual != expected:
            raise ValueError('Media changed')
        if not 0 < stamp.st_size <= MAX_MEDIA_BYTES:
            raise ValueError('Media exceeds limit')
        # Linux validates the opened target as well as the pre-open path. This
        # closes a parent-directory symlink replacement between resolve/open.
        descriptor = Path('/proc/self/fd') / str(fd)
        if descriptor.exists() and descriptor.resolve() != path:
            raise ValueError('Opened media target changed')
        digest, count = hashlib.sha256(), 0
        while not cancelled.is_set():
            chunk = os.read(fd, CHUNK_BYTES)
            if not chunk:
                break
            count += len(chunk)
            if count > MAX_MEDIA_BYTES:
                raise ValueError('Media exceeds limit')
            digest.update(chunk)
        if cancelled.is_set():
            raise ValueError('Cancelled')
        final = os.fstat(fd)
        final_version = stamp_version(final)
        if final_version != expected or count != stamp.st_size or file_version(path) != expected:
            raise ValueError('Media changed during read')
        return digest.hexdigest(), count
    finally:
        os.close(fd)


async def probe_original(path):
    proc = await asyncio.create_subprocess_exec('/usr/bin/ffprobe', '-v', 'error',
        '-show_streams', '-of', 'json', str(path), stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL)
    try:
        # Read incrementally so a malicious metadata block cannot grow RAM.
        output = bytearray()
        async with asyncio.timeout(12):
            while True:
                chunk = await proc.stdout.read(65536)
                if not chunk:
                    break
                output.extend(chunk)
                if len(output) > 1024 * 1024:
                    raise ValueError('Media metadata too large')
            await proc.wait()
        if proc.returncode:
            raise ValueError('Media inspection failed')
        return audio_descriptor(json.loads(output))
    finally:
        if proc.returncode is None:
            proc.kill()
            await proc.wait()


async def probe_stream_prefix(prefix):
    """Inspect original stream metadata in bounded RAM; never pass its URL."""
    proc = await asyncio.create_subprocess_exec('/usr/bin/ffprobe', '-v', 'error',
        '-show_streams', '-of', 'json', '-i', 'pipe:0', stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
    async def feed():
        try:
            proc.stdin.write(prefix)
            await proc.stdin.drain()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            proc.stdin.close()
    sender = asyncio.create_task(feed())
    try:
        output = bytearray()
        async with asyncio.timeout(12):
            while True:
                chunk = await proc.stdout.read(65536)
                if not chunk:
                    break
                output.extend(chunk)
                if len(output) > 1024 * 1024:
                    raise ValueError('Media metadata too large')
            await proc.wait()
        if proc.returncode:
            raise ValueError('Original stream metadata unavailable')
        return audio_descriptor(json.loads(output))
    finally:
        sender.cancel()
        if proc.returncode is None:
            proc.kill()
            await proc.wait()
        await asyncio.gather(sender, return_exceptions=True)


async def proof_hash(job, path, stamp):
    future = asyncio.create_task(asyncio.to_thread(hash_original, path, stamp, job['cancelled']))
    try:
        return await asyncio.shield(future)
    except asyncio.CancelledError:
        job['cancelled'].set()
        await asyncio.gather(future, return_exceptions=True)
        raise


class ScoreIdentity:
    def __init__(self, bridge):
        self.b = bridge
        self.jobs = {}
        self.cache = OrderedDict()

    def owner(self, req):
        if not self.b.authed(req):
            raise web.HTTPUnauthorized(text='请先登录 K歌')
        identity = req.get('fnos_identity')
        if identity:
            return 'nas:' + identity['uid']
        cookie = req.cookies.get('maidong_session', '')
        if self.b.valid_session(cookie):
            return 'session:' + hashlib.sha256(cookie.encode()).hexdigest()
        return 'lan:' + hashlib.sha256(str(req.remote).encode()).hexdigest()

    def resolve(self, sid):
        # Permanent songs retains old accounts and deleted songs. Only the
        # current authorized directory can start/poll/read an identity.
        row = self.b.db.execute('SELECT s.guid,s.data FROM songs s JOIN current_guids c ON c.guid=s.guid WHERE s.id=?',
                                (sid,)).fetchone()
        if row is None:
            raise web.HTTPNotFound(text='歌曲不在当前可访问曲库中')
        guid, data = row['guid'], json.loads(row['data'])
        if guid.startswith('video:'):
            path = self.b.videos.path(guid)
            if path is None:
                raise web.HTTPNotFound(text='原文件已移动或不可访问')
            path = path.resolve()
            if not self.b.videos.allowed(path):
                raise web.HTTPForbidden(text='原文件不在已授权目录中')
            version = file_version(path)
            if not 0 < version[2] <= MAX_MEDIA_BYTES:
                return None, '原文件为空或超过单曲匹配大小限制'
            # Internal-only path and file stamp never enter the JSON response.
            return (guid, data.get('revision'), path, version,
                    tuple(str(root) for root in self.b.videos.roots)), None
        if guid.startswith('fnvideo:'):
            self.b.video_item(guid)
            return None, '影视来源暂未提供已核实的原文件接口'
        if guid.startswith('quark:'):
            self.b.sources.quark.resolve(guid)
            return None, '夸克来源暂未提供已核实的原文件接口'
        upstream = self.b.sources.upstream_guid(guid)
        # /track/stream is a playback endpoint. A 200 + length/format/ETag
        # cannot prove original bytes. The installed official resolver uses
        # this route for direct source-format range playback, while transcode
        # sessions use separate /track/transcode + HLS routes. Enable that
        # adapter only with a locally verified build + explicit source binding.
        proof = self.b.cfg.get('music_original_stream_proof')
        source = self.b.sources.music
        if source.state in ('reauth_required', 'login_failed', 'unconfigured'):
            return None, '音乐来源授权需要重新登录'
        if (not isinstance(proof, dict) or set(proof) != {'url', 'assets', 'manifestSha256'}
                or proof.get('url') != source.data.get('url')
                or proof.get('assets') != PROVEN_MUSIC_ASSETS
                or not isinstance(proof.get('manifestSha256'), str)
                or not re.fullmatch('[0-9a-f]{64}', proof['manifestSha256'])):
            return None, '音乐来源暂未提供已核实的原文件接口'
        if data.get('isCue') is not False:
            return None, 'CUE 分轨或原文件信息未核实，暂不能匹配评分谱'
        try:
            files = [('manifest', MUSIC_MANIFEST, file_version(MUSIC_MANIFEST), proof['manifestSha256'])]
            for name, digest in PROVEN_MUSIC_ASSETS.items():
                path = MUSIC_ASSET_ROOT / name
                if path.is_symlink() or not path.resolve().is_relative_to(MUSIC_ASSET_ROOT.resolve()):
                    raise ValueError('Unverified official build')
                files.append((name, path, file_version(path), digest))
            if any(not 0 < stamp[2] <= 8 * 1024 * 1024 for _, _, stamp, _ in files):
                raise ValueError('Invalid proof file')
        except (OSError, ValueError):
            return None, '音乐应用版本已变更，原文件接口需要重新核实'
        return (guid, data.get('revision'), 'fnmusic', upstream, source.generation,
                source.data.get('scope'), source.data['url'],
                hashlib.sha256(source.data['token'].encode()).hexdigest(), tuple(files)), None

    async def music_hash(self, job):
        snapshot = job['snapshot']
        # Check actual bytes, not only presence/mtime of an old retained asset.
        for _, path, stamp, expected in snapshot[8]:
            actual, _ = await proof_hash(job, path, stamp)
            if actual != expected:
                raise ValueError('Unverified official music build')
        if self.resolve(job['sid'])[0] != snapshot:
            raise ValueError('Source changed')
        source = self.b.sources.music
        headers = {'Cookie': 'music-token=' + source.data['token'], 'Accept-Encoding': 'identity'}
        digest, count, prefix = hashlib.sha256(), 0, bytearray()
        async with self.b.http.get(snapshot[6].rstrip('/') + '/api/v1/track/stream',
                params={'guid': snapshot[3]}, headers=headers, allow_redirects=False, auto_decompress=False,
                timeout=ClientTimeout(total=JOB_TIMEOUT, sock_read=10)) as upstream:
            if upstream.status in (401, 403):
                source.state, source.error = 'reauth_required', '音乐授权已失效，请重新登录'
                raise ValueError('Original stream authorization revoked')
            lengths = upstream.headers.getall('Content-Length', [])
            encoding = upstream.headers.getall('Content-Encoding', [])
            mime = upstream.headers.get('Content-Type', '').split(';', 1)[0].strip().lower()
            if (upstream.status != 200 or 'Content-Range' in upstream.headers or len(lengths) != 1
                    or not re.fullmatch('[0-9]{1,12}', lengths[0])
                    or len(encoding) > 1 or encoding and encoding[0].lower() != 'identity'
                    or not (mime.startswith('audio/') or mime in ('application/octet-stream', 'application/ogg', 'video/mp4'))
                    or 'mpegurl' in mime or 'playlist' in mime):
                raise ValueError('Not a complete original media response')
            expected_size = int(lengths[0])
            if not 0 < expected_size <= MAX_MEDIA_BYTES:
                raise ValueError('Media exceeds limit')
            async for chunk in upstream.content.iter_chunked(CHUNK_BYTES):
                if job['cancelled'].is_set() or self.resolve(job['sid'])[0] != snapshot:
                    raise ValueError('Source permissions/version changed')
                count += len(chunk)
                if count > expected_size or count > MAX_MEDIA_BYTES:
                    raise ValueError('Media length changed')
                digest.update(chunk)
                if len(prefix) < PROBE_PREFIX_BYTES:
                    prefix.extend(chunk[:PROBE_PREFIX_BYTES - len(prefix)])
            if count != expected_size or self.resolve(job['sid'])[0] != snapshot:
                raise ValueError('Incomplete original media')
        if bytes(prefix[:256]).lstrip().lower().startswith((b'#extm3u', b'<?xml', b'<html', b'<!doctype')):
            raise ValueError('Playlist is not original media')
        metadata = await probe_stream_prefix(bytes(prefix))
        if self.resolve(job['sid'])[0] != snapshot or job['cancelled'].is_set():
            raise ValueError('Source changed')
        return digest.hexdigest(), count, metadata

    def prune(self):
        now = time.monotonic()
        for key, (expiry, _) in list(self.cache.items()):
            if expiry <= now:
                del self.cache[key]
        while len(self.cache) > 32:
            self.cache.popitem(last=False)

    async def _run(self, job):
        cancelled = job['cancelled']
        future = None
        try:
            snapshot = job['snapshot']
            async with asyncio.timeout(JOB_TIMEOUT):
                if snapshot[2] == 'fnmusic':
                    digest, size, metadata = await self.music_hash(job)
                else:
                    metadata = await probe_original(snapshot[2])
                    if self.resolve(job['sid'])[0] != snapshot:
                        raise ValueError('Media permissions/version changed')
                    future = asyncio.create_task(asyncio.to_thread(hash_original, snapshot[2], snapshot[3], cancelled))
                    digest, size = await asyncio.shield(future)
                if self.resolve(job['sid'])[0] != snapshot or cancelled.is_set():
                    raise ValueError('Media permissions/version changed')
                job['result'] = {'status': 'ready', 'source': 'original-file-sha256',
                                 'mediaSha256': digest, 'mediaBytes': size, **metadata}
                # Missing upstream updatedAt cannot justify a reusable media
                # version. Such streams may finish, but must be read anew.
                if snapshot[2] != 'fnmusic' or snapshot[1] not in (None, '', '0', 0):
                    self.cache[job['key']] = (time.monotonic() + CACHE_TTL, job['result'])
                self.prune()
        except asyncio.CancelledError:
            cancelled.set()
            raise
        except (OSError, ValueError, TypeError, web.HTTPException, asyncio.TimeoutError, ClientError):
            job['result'] = {'status': 'unavailable', 'message': '原文件暂不可匹配，请确认文件和原唱音轨'}
        finally:
            cancelled.set()
            if future is not None:
                # Retain the global slot until the read has actually stopped.
                await asyncio.gather(future, return_exceptions=True)

    async def _watch(self, job):
        while not job['task'].done():
            await asyncio.sleep(1)
            if time.monotonic() - job['lastPoll'] > POLL_IDLE_SECONDS:
                job['cancelled'].set()
                if not job['task'].cancelling():
                    job['task'].cancel()
                break

    async def cancel(self, owner, sid):
        job = self.jobs.get((owner, sid))
        if job:
            job['cancelled'].set()
            # Repeated panel/connection cleanup must not interrupt the first
            # cancellation's wait for its bounded filesystem read to stop.
            if not job['task'].done() and not job['task'].cancelling():
                job['task'].cancel()
            job['watch'].cancel()
            await asyncio.gather(job['task'], job['watch'], return_exceptions=True)
            if self.jobs.get((owner, sid)) is job:
                del self.jobs[(owner, sid)]

    async def api(self, req):
        if req.method not in ('GET', 'DELETE'):
            raise web.HTTPMethodNotAllowed(req.method, ['GET', 'DELETE'])
        if (len(req.headers.getall('X-Karaoke-Request', [])) != 1
                or req.headers.get('X-Karaoke-Request') != '1'):
            raise web.HTTPForbidden(text='请从 K歌 评分面板请求')
        suffix = req.path.removeprefix('/api/v2/score-identity/')
        if not re.fullmatch(r'[1-9][0-9]{0,9}', suffix) or req.query_string:
            raise web.HTTPBadRequest(text='请选择当前曲库中的歌曲')
        sid, owner = int(suffix), self.owner(req)
        headers = {'Cache-Control': 'private, no-store', 'Vary': 'Cookie'}
        if req.method == 'DELETE':
            await self.cancel(owner, sid)
            return web.json_response({'status': 'cancelled'}, headers=headers)
        snapshot, reason = self.resolve(sid)
        if snapshot is None:
            await self.cancel(owner, sid)
            return web.json_response({'status': 'unavailable', 'message': reason}, headers=headers)
        key = (owner, sid, snapshot)
        self.prune()
        if key in self.cache:
            self.cache.move_to_end(key)
            cached_job = self.jobs.get((owner, sid))
            if cached_job and cached_job['task'].done():
                await self.cancel(owner, sid)
            return web.json_response(self.cache[key][1], headers=headers)
        job = self.jobs.get((owner, sid))
        if job and job['snapshot'] != snapshot:
            await self.cancel(owner, sid)
            return web.json_response({'status': 'unavailable',
                'message': '歌曲或来源已变更，请重新选择后匹配'}, headers=headers)
        if job and job['task'].done():
            result = job.get('result') or {'status': 'unavailable', 'message': '原文件匹配已取消'}
            await self.cancel(owner, sid)
            return web.json_response(result, headers=headers)
        if job is None:
            # No waiting queue: catalog polling cannot schedule a full scan.
            if sum(not item['task'].done() for item in self.jobs.values()) >= MAX_JOBS:
                return web.json_response({'status': 'busy', 'message': '正在匹配另一首原文件，请稍后重试',
                                          'retryAfterMs': 1000}, headers=headers)
            # Retire completed/unpolled jobs, keeping the registry bounded too.
            for identity, old in list(self.jobs.items()):
                if old['task'].done():
                    await self.cancel(*identity)
            job = {'sid': sid, 'key': key, 'snapshot': snapshot, 'cancelled': threading.Event(),
                   'lastPoll': time.monotonic()}
            self.jobs[(owner, sid)] = job
            job['task'] = asyncio.create_task(self._run(job))
            job['watch'] = asyncio.create_task(self._watch(job))
        job['lastPoll'] = time.monotonic()
        return web.json_response({'status': 'pending', 'retryAfterMs': 1000}, headers=headers)

    async def close(self):
        await asyncio.gather(*(self.cancel(*key) for key in list(self.jobs)), return_exceptions=True)
        self.cache.clear()
