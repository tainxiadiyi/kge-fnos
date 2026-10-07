"""Assemble a reviewed allowlist and call the official fnpack executable."""
import argparse
import hashlib
import json
import io
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parents[1]
PLAYER_FILES = frozenset(('webapp.js', 'webapp.css', 'web-player.js', 'web-audio.js', 'web-scorehub.js', 'dsp-worklet.js'))
VENDOR_PROVENANCE = frozenset(('HLS-PROVENANCE.json', 'QRCODE-PROVENANCE.json'))


def server_path(name):
    path = Path(name)
    if path.parent == Path('bridge') and (path.suffix == '.py' and not path.name.startswith('test_')
            or path.name in ('mobile.html', 'singing.html', 'sources.html', 'quark_sources.html', 'requirements.txt')
            or path.name in PLAYER_FILES):
        return Path('app/server') / path.name
    if path.is_relative_to('bridge/web-assets'):
        if path.name in ('feiniu-dsp.js', 'feiniu-dsp.wasm'):
            return None  # Binary/glue artifacts only enter through web_dsp().
        license_file = 'license' in path.name.lower() and path.suffix.lower() in ('', '.txt', '.md')
        provenance = path.parent == Path('bridge/web-assets/vendor') and path.name in VENDOR_PROVENANCE
        if path.suffix.lower() in ('.png', '.jpg', '.jpeg', '.webp', '.svg', '.js') or license_file or provenance:
            return Path('app/server/web-assets') / path.relative_to('bridge/web-assets')
    return None


def web_dsp(package, dsp_dir):
    if dsp_dir is None:
        candidate = ROOT / 'artifacts/fnos/web-dsp'
        if not candidate.is_dir():
            return None
        dsp_dir = candidate
    dsp_dir = Path(dsp_dir).resolve()
    manifest_path = dsp_dir / 'DSP-BUILD.json'
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    hashes, sources = manifest.get('hashes'), manifest.get('recordedSourceDigests')
    names = ('feiniu-dsp.js', 'feiniu-dsp.wasm')
    if not isinstance(hashes, dict) or set(hashes) != set(names) or not isinstance(sources, dict) or not sources:
        raise ValueError('原生音效构建清单不完整')
    for name, digest in sources.items():
        path = Path(name)
        if (path.is_absolute() or '..' in path.parts or ':' in name or '\\' in name
                or not (ROOT / path).resolve().is_relative_to(ROOT)):
            raise ValueError('原生音效源码校验路径无效')
        if hashlib.sha256((ROOT / path).read_bytes()).hexdigest() != digest:
            raise ValueError('原生音效与当前源码不一致，请重新构建')
    destination = package / 'app/server/web-assets/vendor'
    destination.mkdir(parents=True, exist_ok=True)
    for name in names:
        source = dsp_dir / name
        if source.is_symlink() or hashlib.sha256(source.read_bytes()).hexdigest() != hashes[name]:
            raise ValueError('原生音效构建产物校验失败')
        shutil.copyfile(source, destination / name)
    return {'hashes': hashes, 'recordedSourceDigests': sources,
            'manifestSha256': hashlib.sha256(manifest_path.read_bytes()).hexdigest()}


def normalize_archive_modes(payload, *, package=False):
    """fnpack on Windows emits 0666/0777; ship portable POSIX permissions."""
    result = io.BytesIO()
    with tarfile.open(fileobj=io.BytesIO(payload), mode='r:*') as source, tarfile.open(fileobj=result, mode='w:gz') as dest:
        seen, canonical_members = {}, []
        for member in source.getmembers():
            canonical = PurePosixPath(member.name).as_posix()
            if (not member.name or member.name.startswith('/') or '\\' in member.name or ':' in member.name
                    or any(ord(c) < 32 for c in member.name) or '..' in PurePosixPath(member.name).parts
                    or canonical in seen or canonical == '.' and not member.isdir()
                    or not (member.isfile() or member.isdir())):
                raise ValueError('安装包只能包含无路径别名的安全普通文件和目录')
            # fnpack's relative './' names are valid; duplicate canonical paths
            # must never overwrite payload or the final checksum manifest.
            seen[canonical] = member
            canonical_members.append((canonical, member))
        replaced = {}
        if package:
            if not all(name in seen and seen[name].isfile() for name in ('app.tgz', 'manifest')):
                raise ValueError('安装包必须包含普通 app.tgz 和 manifest 文件')
            replaced['app.tgz'] = normalize_archive_modes(source.extractfile(seen['app.tgz']).read())
            checksum = hashlib.md5(replaced['app.tgz']).hexdigest().encode('ascii')
            manifest = source.extractfile(seen['manifest']).read()
            matches = list(re.finditer(rb'(?m)^([ \t]*checksum[ \t]*=[ \t]*)([^\r\n]*?)([ \t]*)(?=\r|\n|$)', manifest))
            if len(matches) != 1:
                raise ValueError('manifest 必须恰好包含一个 checksum 字段')
            match = matches[0]
            replaced['manifest'] = manifest[:match.start(2)] + checksum + manifest[match.end(2):]
        for canonical, member in canonical_members:
            content = replaced[canonical] if canonical in replaced else source.extractfile(member).read() if member.isfile() else None
            if content is not None:
                member.size = len(content)
            member.mode = 0o755 if member.isdir() or package and canonical.startswith('cmd/') else 0o644
            member.uid = member.gid = 0
            member.uname = member.gname = 'root'
            dest.addfile(member, io.BytesIO(content) if content is not None else None)
    return result.getvalue()


def tracked_files():
    files = subprocess.check_output(['git', 'ls-files', '-z'], cwd=ROOT).decode().split('\0')
    # New source additions must be explicitly staged before release packaging.
    return [name for name in files if name]


def stage(out, wheels, dsp_dir=None):
    package = out/'package'
    if package.exists():
        raise ValueError('请使用新的输出目录，保留已有安装包')
    package.mkdir(parents=True)
    names = tracked_files()
    for name in names:
        path = Path(name)
        relative = None
        if name.startswith('deploy/fnos/'):
            relative = path.relative_to('deploy/fnos')
        elif name.startswith('bridge/'):
            relative = server_path(name)
        elif name in ('LICENSE', 'THIRD-PARTY-COMPONENTS.md'):
            relative = Path('app')/path.name
        if relative is not None:
            dest = package/relative
            dest.parent.mkdir(parents=True, exist_ok=True)
            data = (ROOT/path).read_bytes()
            if path.suffix.lower() not in ('.png', '.ico', '.jpg', '.jpeg', '.webp', '.wasm'):
                data = data.replace(b'\r\n', b'\n')
            dest.write_bytes(data)
    # Existing project artwork; only scale to fnOS icon sizes at build time.
    from PIL import Image
    with Image.open(ROOT/'pc/assets/logo.png') as original:
        for size, paths in [(64, ['ICON.PNG', 'app/ui/images/icon_64.png']),
                            (256, ['ICON_256.PNG', 'app/ui/images/icon_256.png'])]:
            icon = original.convert('RGBA')
            icon.thumbnail((size, size), Image.Resampling.LANCZOS)
            canvas = Image.new('RGBA', (size, size))
            canvas.alpha_composite(icon, ((size-icon.width)//2, (size-icon.height)//2))
            for name in paths:
                path = package/name
                path.parent.mkdir(parents=True, exist_ok=True)
                canvas.save(path)
    wheel_files = sorted(wheels.glob('*.whl'))
    if not wheel_files:
        raise ValueError('请先准备 Linux x86_64 / Python 3.12 的离线依赖')
    destination = package/'app/wheels'
    destination.mkdir(parents=True)
    hashes = {}
    for path in wheel_files:
        if not (path.name.endswith('-none-any.whl') or
                'x86_64' in path.name and ('cp312' in path.name or 'abi3' in path.name)):
            raise ValueError('依赖架构与 x86 / Python 3.12 安装包不匹配')
        shutil.copyfile(path, destination/path.name)
        hashes[path.name] = hashlib.sha256(path.read_bytes()).hexdigest()
    (destination/'SHA256.json').write_text(json.dumps(hashes, indent=2), encoding='utf-8')
    provenance = {'sourceCommit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT).decode().strip(),
                  'workingTreeChanges': bool(subprocess.check_output(['git', 'status', '--porcelain'], cwd=ROOT)),
                  'platform': 'x86', 'runtime': 'python312', 'dependencies': hashes}
    dsp = web_dsp(package, dsp_dir)
    if dsp:
        provenance['webDsp'] = dsp
    (package/'app/SOURCE.json').write_text(json.dumps(provenance, indent=2), encoding='utf-8')
    return package


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--wheelhouse', type=Path, required=True)
    parser.add_argument('--fnpack', type=Path, required=True)
    parser.add_argument('--dsp-dir', type=Path)
    args = parser.parse_args()
    out = args.out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    package = stage(out, args.wheelhouse.resolve(), args.dsp_dir)
    subprocess.run([str(args.fnpack.resolve()), 'build', '--directory', str(package)], cwd=out, check=True)
    candidates = list(out.glob('*.fpk')) + list(package.glob('*.fpk'))
    if len(candidates) != 1:
        raise ValueError('未找到唯一的 fnpack 产物')
    built = candidates[0]
    built.write_bytes(normalize_archive_modes(built.read_bytes(), package=True))
    version = next(line.split('=', 1)[1].strip() for line in (package/'manifest').read_text(encoding='utf-8').splitlines() if line.startswith('version='))
    result = out/f'feiniu-karaoke-nas-{version}-x86.fpk'
    if built != result:
        shutil.move(str(built), result)
    digest = hashlib.sha256(result.read_bytes()).hexdigest()
    (out/'SHA256SUMS.txt').write_text(f'{digest}  {result.name}\n', encoding='utf-8')
    print(json.dumps({'package': str(result), 'sha256': digest, 'bytes': result.stat().st_size}))


if __name__ == '__main__':
    main()
