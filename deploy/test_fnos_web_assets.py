import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location('build_fpk_web', Path(__file__).with_name('build_fpk.py'))
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)


class BrowserPackageTests(unittest.TestCase):
    def test_only_runtime_and_reviewed_browser_assets_are_selected(self):
        included = ['bridge/server.py', 'bridge/web_catalog.py', 'bridge/singing.html', 'bridge/webapp.js',
            'bridge/webapp.css', 'bridge/web-player.js', 'bridge/web-audio.js', 'bridge/web-scorehub.js', 'bridge/dsp-worklet.js',
            'bridge/web-assets/android/icon.png', 'bridge/web-assets/vendor/hls.min.js',
            'bridge/web-assets/vendor/hls-LICENSE.txt', 'bridge/quark_source.py', 'bridge/quark_sources.html',
            'bridge/web-assets/vendor/qrcode.js', 'bridge/web-assets/vendor/STK.LICENSE.txt',
            'bridge/web-assets/vendor/Signalsmith-Stretch.LICENSE.txt', 'bridge/web-assets/vendor/Signalsmith-Linear.LICENSE.txt',
            'bridge/web-assets/vendor/DSPFilters.LICENSE.txt', 'bridge/web-assets/vendor/HLS-PROVENANCE.json',
            'bridge/web-assets/vendor/QRCODE-PROVENANCE.json']
        excluded = ['bridge/test_server.py', 'bridge/config.json', 'bridge/private.js',
            'bridge/state.db', 'bridge/web-assets/private.json', 'bridge/web-assets/model.bin',
            'bridge/web-assets/vendor/feiniu-dsp.wasm', 'bridge/web-assets/private.txt',
            'bridge/web-assets/vendor/private.json', 'bridge/web-assets/HLS-PROVENANCE.json',
            'bridge/web-assets/vendor/nested/QRCODE-PROVENANCE.json']
        for name in included:
            with self.subTest(name=name):
                self.assertIsNotNone(build.server_path(name))
        for name in excluded:
            with self.subTest(name=name):
                self.assertIsNone(build.server_path(name))

    def test_optional_dsp_requires_matching_binary_and_current_source_digests(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / 'app/src/main/cpp/music_dsp.cpp'
            source.parent.mkdir(parents=True)
            source.write_bytes(b'fixture source')
            dsp = root / 'dsp'
            dsp.mkdir()
            names = ('feiniu-dsp.js', 'feiniu-dsp.wasm')
            for name in names:
                (dsp / name).write_bytes(b'fixture ' + name.encode())
            digest = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
            manifest = {'version': 1, 'hashes': {name: digest(dsp / name) for name in names},
                'recordedSourceDigests': {'app/src/main/cpp/music_dsp.cpp': digest(source)}}
            (dsp / 'DSP-BUILD.json').write_text(json.dumps(manifest))
            with patch.object(build, 'ROOT', root):
                result = build.web_dsp(root / 'package', dsp)
                self.assertEqual(result['hashes'], manifest['hashes'])
                self.assertEqual((root / 'package/app/server/web-assets/vendor/feiniu-dsp.wasm').read_bytes(),
                    (dsp / 'feiniu-dsp.wasm').read_bytes())
                source.write_bytes(b'changed source')
                with self.assertRaisesRegex(ValueError, '源码不一致'):
                    build.web_dsp(root / 'another-package', dsp)
                source.write_bytes(b'fixture source')
                (dsp / 'feiniu-dsp.wasm').write_bytes(b'corrupt')
                with self.assertRaisesRegex(ValueError, '产物校验失败'):
                    build.web_dsp(root / 'third-package', dsp)
                manifest['recordedSourceDigests'] = {'../outside.cpp': 'bad'}
                (dsp / 'DSP-BUILD.json').write_text(json.dumps(manifest))
                with self.assertRaisesRegex(ValueError, '路径无效'):
                    build.web_dsp(root / 'fourth-package', dsp)


if __name__ == '__main__':
    unittest.main()
