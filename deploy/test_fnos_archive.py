import importlib.util
import hashlib
import io
from pathlib import Path
import tarfile
import unittest


spec = importlib.util.spec_from_file_location('build_fpk', Path(__file__).with_name('build_fpk.py'))
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)


def archive(entries):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w:gz') as tar:
        for name, kind, content in entries:
            member = tarfile.TarInfo(name)
            member.type = kind
            member.mode = 0o777 if kind == tarfile.DIRTYPE else 0o666
            member.uid, member.gid = 1234, 5678
            member.uname, member.gname = 'fixture-user', 'fixture-group'
            if kind in (tarfile.SYMTYPE, tarfile.LNKTYPE):
                member.linkname = '/outside-package'
            member.size = len(content) if kind == tarfile.REGTYPE else 0
            tar.addfile(member, io.BytesIO(content) if kind == tarfile.REGTYPE else None)
    return output.getvalue()


class ArchiveModeTests(unittest.TestCase):
    def test_windows_modes_are_fixed_in_outer_and_inner_archive_without_content_loss(self):
        inner = archive([('server', tarfile.DIRTYPE, b''),
                         ('server/server.py', tarfile.REGTYPE, b'print("fixture")\n'),
                         ('ui/icon.png', tarfile.REGTYPE, b'\x89PNG\r\nfixture')])
        outer = archive([('cmd', tarfile.DIRTYPE, b''),
                         ('cmd/main', tarfile.REGTYPE, b'#!/bin/sh\nexit 0\n'),
                         ('cmd/install_callback', tarfile.REGTYPE, b'#!/bin/sh\nexit 0\n'),
                         ('manifest', tarfile.REGTYPE, b'appname=fixture\nchecksum=old\n'),
                         ('app.tgz', tarfile.REGTYPE, inner)])
        fixed = build.normalize_archive_modes(outer, package=True)
        with tarfile.open(fileobj=io.BytesIO(fixed), mode='r:gz') as tar:
            for member in tar.getmembers():
                self.assertEqual(member.mode, 0o755 if member.isdir() or member.name.startswith('cmd/') else 0o644)
                self.assertEqual((member.uid,member.gid,member.uname,member.gname),(0,0,'root','root'))
            self.assertEqual(tar.extractfile('cmd/main').read(), b'#!/bin/sh\nexit 0\n')
            final_app = tar.extractfile('app.tgz').read()
            self.assertEqual(tar.extractfile('manifest').read(),
                b'appname=fixture\nchecksum=' + hashlib.md5(final_app).hexdigest().encode() + b'\n')
            with tarfile.open(fileobj=io.BytesIO(final_app), mode='r:gz') as app:
                for member in app.getmembers():
                    self.assertEqual(member.mode, 0o755 if member.isdir() else 0o644)
                    self.assertEqual((member.uid,member.gid),(0,0))
                self.assertEqual(app.extractfile('server/server.py').read(), b'print("fixture")\n')
                self.assertEqual(app.extractfile('ui/icon.png').read(), b'\x89PNG\r\nfixture')

    def test_checksum_matches_final_app_bytes_in_both_member_orders_and_preserves_other_fields(self):
        inner = archive([('server/server.py', tarfile.REGTYPE, b'unchanged source bytes')])
        old = hashlib.md5(inner).hexdigest().encode()
        manifest = b'appname=fixture\r\r\n  checksum   =    ' + old + b'  \r\r\nversion=2\n'
        for order in ('manifest-first', 'app-first'):
            entries = [('manifest', tarfile.REGTYPE, manifest), ('app.tgz', tarfile.REGTYPE, inner)]
            if order == 'app-first':
                entries.reverse()
            fixed = build.normalize_archive_modes(archive(entries), package=True)
            with tarfile.open(fileobj=io.BytesIO(fixed)) as tar:
                content = tar.extractfile('app.tgz').read()
                checksum = hashlib.md5(content).hexdigest().encode()
                self.assertNotEqual(checksum, old)
                self.assertEqual(tar.extractfile('manifest').read(), manifest.replace(old, checksum))

    def test_missing_or_duplicate_checksum_and_missing_required_members_are_rejected(self):
        inner = archive([('runtime.py', tarfile.REGTYPE, b'data')])
        for manifest in (b'appname=fixture\n', b'checksum=a\n checksum = b\n'):
            outer = archive([('manifest', tarfile.REGTYPE, manifest), ('app.tgz', tarfile.REGTYPE, inner)])
            with self.assertRaises(ValueError):
                build.normalize_archive_modes(outer, package=True)
        for name, data in (('manifest', b'checksum=old\n'), ('app.tgz', inner)):
            with self.assertRaises(ValueError):
                build.normalize_archive_modes(archive([(name, tarfile.REGTYPE, data)]), package=True)

    def test_aliases_and_traversal_rejected_at_both_levels(self):
        for unsafe in ('../runtime.py', '/runtime.py', 'a\\runtime.py', 'C:runtime.py'):
            with self.subTest(path=unsafe), self.assertRaises(ValueError):
                build.normalize_archive_modes(archive([(unsafe, tarfile.REGTYPE, b'data')]))
        for first, alias in (('runtime.py', './runtime.py'), ('a/b', 'a/./b'), ('a/b', 'a//b')):
            inner = archive([(first, tarfile.REGTYPE, b'first'), (alias, tarfile.REGTYPE, b'second')])
            with self.subTest(alias=alias), self.assertRaises(ValueError):
                build.normalize_archive_modes(inner)
            outer = archive([('manifest', tarfile.REGTYPE, b'checksum=old\n'),
                             ('app.tgz', tarfile.REGTYPE, inner)])
            with self.subTest(inner=alias), self.assertRaises(ValueError):
                build.normalize_archive_modes(outer, package=True)
        inner = archive([('runtime.py', tarfile.REGTYPE, b'data')])
        outer = archive([('manifest', tarfile.REGTYPE, b'checksum=old\n'),
                         ('./manifest', tarfile.REGTYPE, b'checksum=other\n'), ('app.tgz', tarfile.REGTYPE, inner)])
        with self.assertRaises(ValueError):
            build.normalize_archive_modes(outer, package=True)

    def test_relative_fnpack_members_are_canonicalized_for_modes_and_checksum(self):
        inner = archive([('./', tarfile.DIRTYPE, b''), ('./ui/', tarfile.DIRTYPE, b''),
                         ('./ui/index.html', tarfile.REGTYPE, b'original page')])
        outer = archive([('./', tarfile.DIRTYPE, b''), ('./cmd/', tarfile.DIRTYPE, b''),
                         ('./cmd/main', tarfile.REGTYPE, b'#!/bin/sh\n'),
                         ('./manifest', tarfile.REGTYPE, b'checksum=old\n'), ('./app.tgz', tarfile.REGTYPE, inner)])
        fixed = build.normalize_archive_modes(outer, package=True)
        with tarfile.open(fileobj=io.BytesIO(fixed)) as tar:
            app = tar.extractfile('./app.tgz').read()
            self.assertEqual(tar.extractfile('./manifest').read(),
                b'checksum=' + hashlib.md5(app).hexdigest().encode() + b'\n')
            self.assertEqual(tar.getmember('./cmd/main').mode, 0o755)
            self.assertEqual(tar.getmember('.').mode, 0o755)

    def test_links_and_special_files_are_rejected_at_both_archive_levels(self):
        for kind in (tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.FIFOTYPE, tarfile.CHRTYPE):
            bad = archive([('unsafe',kind,b'')])
            with self.subTest(kind=kind), self.assertRaises(ValueError):
                build.normalize_archive_modes(bad,package=True)
            outer = archive([('app.tgz',tarfile.REGTYPE,bad)])
            with self.subTest(kind=kind,inner=True), self.assertRaises(ValueError):
                build.normalize_archive_modes(outer,package=True)


if __name__ == '__main__':
    unittest.main()
