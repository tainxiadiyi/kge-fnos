import asyncio
import hashlib
import json
from pathlib import Path
import secrets
import tempfile
import threading
import unittest
from unittest.mock import AsyncMock, patch

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from score_identity import audio_descriptor, file_version, hash_original
from server import COOKIE, create_app


PREFIX = '/app/feiniu-karaoke'


class OriginalFileTests(unittest.TestCase):
    def test_audio_ordinals_are_not_container_indexes_and_ambiguous_tracks_are_not_guessed(self):
        metadata = {'streams': [{'index': 0, 'codec_type': 'video'},
            {'index': 3, 'codec_type': 'audio', 'tags': {'title': '伴奏'}},
            {'index': 7, 'codec_type': 'audio', 'tags': {'title': '原唱'}}]}
        result = audio_descriptor(metadata)
        self.assertEqual(result['originalAudioTrack'], 1)
        self.assertEqual([t['audioTrack'] for t in result['audioTracks']], [0, 1])
        self.assertEqual(result['selectionMethod'], 'explicit-original')
        metadata['streams'][1]['tags'] = {}
        metadata['streams'][2]['tags'] = {'title': 'file:///private/library/song.mp4'}
        result = audio_descriptor(metadata)
        self.assertIsNone(result['originalAudioTrack'])
        self.assertEqual(result['audioTracks'][1]['title'], '')
        self.assertEqual(audio_descriptor({'streams': [{'codec_type': 'audio'}]})['originalAudioTrack'], 0)
        self.assertIsNone(audio_descriptor({'streams': [{'codec_type': 'audio', 'tags': {'title': 'no vocal'}}]})['originalAudioTrack'])

    def test_hash_reads_complete_original_and_rejects_changed_version_or_cancel(self):
        with tempfile.TemporaryDirectory() as name:
            path = Path(name) / 'original.mp4'
            media = b'container header' + b'original audio and video' * 100000 + b'end of original'
            path.write_bytes(media)
            version = file_version(path)
            digest, count = hash_original(path, version, threading.Event())
            self.assertEqual(digest, hashlib.sha256(media).hexdigest())
            self.assertEqual(count, len(media))
            path.write_bytes(b'changed file')
            with self.assertRaises(ValueError):
                hash_original(path, version, threading.Event())
            stopped = threading.Event(); stopped.set()
            with self.assertRaises(ValueError):
                hash_original(path, file_version(path), stopped)
            self.assertEqual(list(Path(name).iterdir()), [path])


class IdentityApiTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.folder = Path(self.temp.name)
        self.media_root = self.folder / 'authorized'
        self.media_root.mkdir()
        self.media = self.media_root / 'original.mp4'
        self.original = b'FULL ORIGINAL CONTAINER ' * 14000 + b'moov at the end'
        self.media.write_bytes(self.original)
        cfg = dict(base_path=PREFIX, lan_networks=[], username='synthetic',
            session_key=secrets.token_hex(32), music_url='https://invalid.synthetic/music',
            music_token='synthetic-private-source-token', password_salt='00' * 16, password_hash='',
            catalog_sync_enabled=False, score_generation_enabled=False, video_roots=[str(self.media_root)],
            cache_dir=str(self.folder / 'cache'), score_cache_dir=str(self.folder / 'scores'))
        self.app = create_app(cfg, self.folder / 'state.db')
        self.b = self.app['bridge']
        self.song(1, 'video:original')
        self.b.db.execute('INSERT INTO video_sources VALUES(?,?,?,?)',
                          ('video:original', str(self.media), 'fixture', '{}'))
        self.b.db.commit()
        self.client = TestClient(TestServer(self.app))
        await self.client.start_server()
        self.headers = {'Cookie': COOKIE + '=' + self.b.session(), 'X-Karaoke-Request': '1'}
        self.metadata = {'audioTracks': [{'audioTrack': 0, 'title': '伴奏', 'role': 'accompaniment'},
            {'audioTrack': 1, 'title': '原唱', 'role': 'original'}], 'originalAudioTrack': 1,
            'selectionMethod': 'explicit-original'}
        self.probe = patch('score_identity.probe_original', AsyncMock(return_value=self.metadata)).start()
        self.addCleanup(patch.stopall)
        self.upstreams = []

    async def asyncTearDown(self):
        await self.client.close()
        for upstream in self.upstreams:
            await upstream.close()
        self.temp.cleanup()

    def song(self, sid, guid, *, visible=True):
        with self.b.db:
            self.b.db.execute('INSERT INTO songs VALUES(?,?,?)', (sid, guid,
                json.dumps({'title': 'Synthetic song', 'revision': 'fixture', 'media_kind': 'mv'})))
            if visible:
                self.b.db.execute('INSERT INTO current_guids VALUES(?)', (guid,))

    def url(self, sid=1):
        return PREFIX + '/api/v2/score-identity/' + str(sid)

    async def ready(self, sid=1, headers=None):
        for _ in range(100):
            response = await self.client.get(self.url(sid), headers=headers or self.headers)
            self.assertEqual(response.status, 200)
            body = await response.json()
            self.assertEqual(response.headers['Cache-Control'], 'private, no-store')
            if body['status'] != 'pending':
                return body
            await asyncio.sleep(.01)
        self.fail('Fingerprint did not finish')

    async def test_complete_file_hash_and_private_descriptor_without_media_copy(self):
        before = set(self.folder.rglob('*'))
        result = await self.ready()
        self.assertEqual(result['status'], 'ready')
        self.assertEqual(result['mediaSha256'], hashlib.sha256(self.original).hexdigest())
        self.assertEqual(result['mediaBytes'], len(self.original))
        self.assertEqual(result['originalAudioTrack'], 1)
        self.assertNotIn(str(self.folder), json.dumps(result))
        self.assertNotIn('synthetic-private-source-token', json.dumps(result))
        self.assertNotIn('url', json.dumps(result).lower())
        self.assertEqual(set(self.folder.rglob('*')), before)
        # Cached reads still prove the song is in the current authorized view.
        with self.b.db:
            self.b.db.execute('DELETE FROM current_guids')
        self.assertEqual((await self.client.get(self.url(), headers=self.headers)).status, 404)

    async def test_file_version_invalidation_and_user_scoped_cache(self):
        first = await self.ready()
        again = await self.ready()
        self.assertEqual(first, again)
        self.assertEqual(self.probe.await_count, 1)
        another = {'Cookie': COOKIE + '=' + self.b.session(), 'X-Karaoke-Request': '1'}
        self.assertEqual((await self.ready(headers=another))['mediaSha256'], first['mediaSha256'])
        self.assertEqual(self.probe.await_count, 2)
        self.media.write_bytes(b'NEW ORIGINAL FILE')
        changed = await self.ready()
        self.assertEqual(changed['mediaSha256'], hashlib.sha256(b'NEW ORIGINAL FILE').hexdigest())
        self.assertNotEqual(changed['mediaSha256'], first['mediaSha256'])

    async def test_access_header_visibility_source_scope_and_no_arbitrary_parameters(self):
        self.assertEqual((await self.client.get(self.url(), headers={'X-Karaoke-Request': '1'})).status, 401)
        self.assertEqual((await self.client.get(self.url(), headers={'Cookie': self.headers['Cookie']})).status, 403)
        self.assertEqual((await self.client.get(self.url() + '?url=https://other/private', headers=self.headers)).status, 400)
        self.assertEqual((await self.client.post(self.url(), headers=self.headers, json={})).status, 405)
        self.song(2, 'video:hidden', visible=False)
        self.assertEqual((await self.client.get(self.url(2), headers=self.headers)).status, 404)
        self.song(3, 'music:other-account:old-track')
        self.assertEqual((await self.client.get(self.url(3), headers=self.headers)).status, 403)
        self.probe.assert_not_awaited()

    async def test_unproven_playback_sources_are_unavailable_and_do_not_fetch_network(self):
        self.song(2, 'legacy-music-guid')
        self.song(3, 'fnvideo:fixture:item')
        self.b.sources.video.data = {'token': 'synthetic-video', 'scope': 'fixture'}
        self.song(4, 'quark:fixture:item')
        with patch.object(self.b.sources.quark, 'resolve', return_value={'fid': 'synthetic'}), \
                patch.object(self.b, 'video_media', AsyncMock()) as video_stream, \
                patch.object(self.b, 'feed_audio', AsyncMock()) as audio_stream:
            for sid in (2, 3, 4):
                result = await self.ready(sid)
                self.assertEqual(result['status'], 'unavailable')
                self.assertNotIn('mediaSha256', result)
            video_stream.assert_not_awaited(); audio_stream.assert_not_awaited()
        self.probe.assert_not_awaited()
        self.b.sources.music.logout()
        self.assertEqual((await self.client.get(self.url(2), headers=self.headers)).status, 403)

    async def test_concurrency_cancel_and_completed_task_cleanup(self):
        entered, release = asyncio.Event(), asyncio.Event()
        async def slow_probe(path):
            entered.set()
            await release.wait()
            return self.metadata
        self.probe.side_effect = slow_probe
        result = await (await self.client.get(self.url(), headers=self.headers)).json()
        self.assertEqual(result['status'], 'pending')
        await entered.wait()
        other_user = {'Cookie': COOKIE + '=' + self.b.session(), 'X-Karaoke-Request': '1'}
        result = await (await self.client.get(self.url(), headers=other_user)).json()
        self.assertEqual(result['status'], 'busy')
        # A different user cannot cancel the owner who is reading this song.
        await self.client.delete(self.url(), headers=other_user)
        self.assertEqual(len(self.b.score_identity.jobs), 1)
        result = await (await self.client.delete(self.url(), headers=self.headers)).json()
        self.assertEqual(result['status'], 'cancelled')
        self.assertEqual(self.b.score_identity.jobs, {})
        self.assertEqual(self.b.score_identity.cache, {})
        release.set()
        self.assertEqual((await self.ready())['status'], 'ready')

    async def test_permission_change_during_hash_cannot_publish_identity(self):
        entered, release = threading.Event(), threading.Event()
        original_hash = hash_original
        def held_hash(path, version, cancelled):
            entered.set(); release.wait(2)
            return original_hash(path, version, cancelled)
        with patch('score_identity.hash_original', held_hash):
            await self.client.get(self.url(), headers=self.headers)
            self.assertTrue(await asyncio.to_thread(entered.wait, 2))
            with self.b.db:
                self.b.db.execute('DELETE FROM current_guids')
            release.set()
            for job in list(self.b.score_identity.jobs.values()):
                await job['task']
                self.assertEqual(job['result']['status'], 'unavailable')
            self.assertEqual(self.b.score_identity.cache, {})

    async def test_closed_panel_idle_task_is_cancelled_without_storing_media(self):
        entered = asyncio.Event()
        async def never_probe(path):
            entered.set(); await asyncio.Event().wait()
        self.probe.side_effect = never_probe
        with patch('score_identity.POLL_IDLE_SECONDS', 0):
            await self.client.get(self.url(), headers=self.headers)
            await entered.wait()
            job = next(iter(self.b.score_identity.jobs.values()))
            await asyncio.sleep(1.05)
            self.assertTrue(job['task'].cancelled())
            self.assertEqual(self.b.score_identity.cache, {})

    async def test_cancel_waits_until_active_read_stops_and_outside_roots_are_denied(self):
        entered, stopped = threading.Event(), threading.Event()
        def held_reader(path, version, cancelled):
            entered.set()
            self.assertTrue(cancelled.wait(2))
            stopped.set()
            raise ValueError('cancelled fixture read')
        with patch('score_identity.hash_original', held_reader):
            await self.client.get(self.url(), headers=self.headers)
            self.assertTrue(await asyncio.to_thread(entered.wait, 2))
            result = await (await self.client.delete(self.url(), headers=self.headers)).json()
            self.assertEqual(result['status'], 'cancelled')
            self.assertTrue(stopped.is_set())
            self.assertEqual(self.b.score_identity.jobs, {})
        outside = self.folder / 'private.mp4'
        outside.write_bytes(b'not in authorized directory')
        with self.b.db:
            self.b.db.execute('UPDATE video_sources SET path=?', (str(outside),))
        self.assertEqual((await self.client.get(self.url(), headers=self.headers)).status, 404)

    async def music_fixture(self, handler):
        upstream = web.Application()
        upstream.router.add_get('/music/api/v1/track/stream', handler)
        client = TestClient(TestServer(upstream))
        await client.start_server()
        self.upstreams.append(client)
        source = self.b.sources.music
        source.data['url'] = str(client.make_url('/music'))
        source.state = 'authenticated'
        assets = self.folder / 'official-assets'
        assets.mkdir()
        proofs = {'resolver.js': b'synthetic direct resolver', 'routes.js': b'synthetic routes'}
        expected = {}
        for name, data in proofs.items():
            (assets / name).write_bytes(data)
            expected[name] = hashlib.sha256(data).hexdigest()
        manifest = self.folder / 'official-manifest'
        manifest.write_bytes(b'appname=trim.music\nversion=synthetic\n')
        patch('score_identity.MUSIC_ASSET_ROOT', assets).start()
        patch('score_identity.MUSIC_MANIFEST', manifest).start()
        patch('score_identity.PROVEN_MUSIC_ASSETS', expected).start()
        self.b.cfg['music_original_stream_proof'] = {'url': source.data['url'], 'assets': expected,
            'manifestSha256': hashlib.sha256(manifest.read_bytes()).hexdigest()}
        self.song(2, 'music-original-fixture')
        with self.b.db:
            self.b.db.execute('UPDATE songs SET data=? WHERE id=2',
                (json.dumps({'revision': '1', 'isCue': False, 'media_kind': 'audio'}),))
        return client, assets, manifest

    async def test_verified_music_hash_uses_complete_direct_bytes_without_playback_transcode_or_credentials_leak(self):
        hits = []
        raw = b'FULL ORIGINAL MUSIC BYTES ' * 410000  # exceeds metadata-prefix budget
        async def stream(req):
            hits.append(req.query.copy())
            self.assertEqual(req.headers.get('Accept-Encoding'), 'identity')
            self.assertEqual(req.headers.get('Cookie'), 'music-token=synthetic-private-source-token')
            self.assertNotIn('Range', req.headers)
            return web.Response(body=raw, content_type='audio/flac')
        await self.music_fixture(stream)
        with patch('score_identity.probe_stream_prefix', AsyncMock(return_value=self.metadata)) as probe:
            result = await self.ready(2)
            self.assertEqual(result['status'], 'ready')
            self.assertEqual(result['mediaSha256'], hashlib.sha256(raw).hexdigest())
            self.assertEqual(result['mediaBytes'], len(raw))
            self.assertEqual(dict(hits[0]), {'guid': 'music-original-fixture'})
            self.assertEqual(len(hits), 1)
            self.assertEqual(len(probe.await_args.args[0]), 8 * 1024 * 1024)
            self.assertNotIn(str(self.folder), json.dumps(result))
            self.assertNotIn('synthetic-private-source-token', json.dumps(result))

    async def test_music_proof_source_binding_cue_build_and_static_digest_fail_closed(self):
        calls = []
        async def stream(req):
            calls.append(req.query.copy())
            return web.Response(body=b'original', content_type='audio/flac')
        _, assets, manifest = await self.music_fixture(stream)
        with patch('score_identity.probe_stream_prefix', AsyncMock(return_value=self.metadata)):
            self.b.cfg['music_original_stream_proof']['url'] = 'https://different.invalid/music'
            self.assertEqual((await self.ready(2))['status'], 'unavailable')
            self.b.cfg['music_original_stream_proof']['url'] = self.b.sources.music.data['url']
            with self.b.db:
                self.b.db.execute('UPDATE songs SET data=? WHERE id=2', (json.dumps({'isCue': True}),))
            self.assertEqual((await self.ready(2))['status'], 'unavailable')
            with self.b.db:
                self.b.db.execute('UPDATE songs SET data=? WHERE id=2', (json.dumps({'isCue': False}),))
            manifest.write_bytes(b'new version')
            self.assertEqual((await self.ready(2))['status'], 'unavailable')
            self.b.cfg['music_original_stream_proof']['manifestSha256'] = hashlib.sha256(manifest.read_bytes()).hexdigest()
            (assets / 'resolver.js').write_bytes(b'not the audited direct resolver')
            self.assertEqual((await self.ready(2))['status'], 'unavailable')
            self.assertEqual(calls, [])

    async def test_music_partial_encoded_playlist_redirect_or_incomplete_stream_never_publishes_hash(self):
        mode = 'partial'
        async def stream(req):
            if mode == 'partial':
                return web.Response(status=206, body=b'part', headers={'Content-Range': 'bytes 1-4/20'}, content_type='audio/flac')
            if mode == 'encoded':
                return web.Response(body=b'encoded', headers={'Content-Encoding': 'gzip'}, content_type='audio/flac')
            if mode == 'playlist':
                return web.Response(body=b'#EXTM3U\nother-song.ts', content_type='audio/flac')
            if mode == 'redirect':
                return web.Response(status=302, headers={'Location': 'https://never-fetch.invalid/other'})
            if mode == 'chunked':
                response = web.StreamResponse(headers={'Content-Type': 'audio/flac'})
                await response.prepare(req); await response.write(b'unknown-length'); await response.write_eof()
                return response
            response = web.StreamResponse(headers={'Content-Length': '20', 'Content-Type': 'audio/flac'})
            await response.prepare(req); await response.write(b'truncated'); req.transport.close()
            return response
        await self.music_fixture(stream)
        with patch('score_identity.probe_stream_prefix', AsyncMock(return_value=self.metadata)) as probe:
            for value in ('partial', 'encoded', 'playlist', 'redirect', 'chunked', 'incomplete'):
                mode = value
                result = await self.ready(2)
                self.assertEqual(result['status'], 'unavailable', value)
                self.assertNotIn('mediaSha256', result, value)
            probe.assert_not_awaited()

    async def test_music_source_change_midstream_and_revoked_authorization_invalidate_cached_identity(self):
        change = False
        async def stream(req):
            if change:
                self.b.sources.music.generation += 1
                return web.Response(body=b'changed account raw', content_type='audio/flac')
            return web.Response(body=b'current raw', content_type='audio/flac')
        await self.music_fixture(stream)
        with patch('score_identity.probe_stream_prefix', AsyncMock(return_value=self.metadata)):
            good = await self.ready(2)
            self.assertEqual(good['status'], 'ready')
            self.b.sources.music.state = 'reauth_required'
            self.assertEqual((await self.ready(2))['status'], 'unavailable')
            self.b.sources.music.state = 'authenticated'
            self.b.score_identity.cache.clear()
            change = True
            self.assertEqual((await self.ready(2))['status'], 'unavailable')
            self.assertEqual(self.b.score_identity.cache, {})


if __name__ == '__main__':
    unittest.main()
