#!/usr/bin/env python3
"""Prepare reproducible preview metadata or verify an actual macOS bundle/DMG."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
NATIVE = ROOT / 'apps/operator/src-tauri'

def run(*args):
    return subprocess.check_output(args, text=True).strip()

def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()

def inventory(app):
    entries = {}
    for path in sorted(app.rglob('*')):
        name = path.relative_to(app).as_posix()
        if path.is_symlink():
            entries[name] = {'symlink': os.readlink(path)}
        elif path.is_file():
            entries[name] = {'sha256': digest(path), 'size': path.stat().st_size}
    return entries

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('operation', choices=['prepare', 'verify'])
    parser.add_argument('--architecture', choices=['arm64', 'x86_64'])
    args = parser.parse_args()
    revision = run('git', '-C', str(ROOT), 'rev-parse', 'HEAD')
    if os.environ.get('GITHUB_SHA'):
        assert revision == os.environ['GITHUB_SHA'], 'Source differs from workflow checkout'
    config = json.loads((NATIVE / 'tauri.conf.json').read_text())
    target = NATIVE / 'target'
    if args.operation == 'prepare':
        target.mkdir(exist_ok=True)
        info = plistlib.loads((NATIVE / 'Info.plist').read_bytes())
        info['MultilinguumSourceRevision'] = revision
        path = target / 'preview-Info.plist'
        path.write_bytes(plistlib.dumps(info))
        (target / 'preview-config.json').write_text(json.dumps({
            'bundle': {'macOS': {'infoPlist': str(path.resolve()), 'signingIdentity': '-'}}
        }) + '\n')
        print('Prepared source-labelled ad-hoc preview metadata.')
        return
    assert args.architecture, 'Select the native package architecture explicitly'
    app = target / 'release/bundle/macos/Multilinguum.app'
    info = plistlib.loads((app / 'Contents/Info.plist').read_bytes())
    assert info['CFBundleIdentifier'] == config['identifier']
    assert info['CFBundleShortVersionString'] == config['version']
    assert info['MultilinguumSourceRevision'] == revision
    assert info.get('NSMicrophoneUsageDescription'), 'Microphone purpose is missing'
    assert info['LSMinimumSystemVersion'] == config['bundle']['macOS']['minimumSystemVersion']
    binary = app / 'Contents/MacOS' / info['CFBundleExecutable']
    assert run('lipo', '-archs', str(binary)).split() == [args.architecture]
    subprocess.run(['codesign', '--verify', '--deep', '--strict', str(app)], check=True)
    linked = run('otool', '-L', str(binary)).splitlines()[1:]
    assert linked and all(line.strip().startswith(('/System/Library/', '/usr/lib/', '@rpath/', '@loader_path/', '@executable_path/')) for line in linked), 'Non-portable library dependency'
    dmgs = list((target / 'release/bundle/dmg').glob('*.dmg'))
    assert len(dmgs) == 1, 'Expected exactly one installer in the clean build directory'
    dmg = dmgs[0]
    subprocess.run(['hdiutil', 'verify', str(dmg)], check=True, stdout=subprocess.DEVNULL)
    with tempfile.TemporaryDirectory(prefix='multilinguum-dmg-check-') as mount:
        subprocess.run(['hdiutil', 'attach', '-readonly', '-nobrowse', '-mountpoint', mount, str(dmg)], check=True, stdout=subprocess.DEVNULL)
        try:
            installed = Path(mount) / 'Multilinguum.app'
            assert inventory(installed) == inventory(app), 'Installer differs from the verified app'
            subprocess.run(['codesign', '--verify', '--deep', '--strict', str(installed)], check=True)
        finally:
            subprocess.run(['hdiutil', 'detach', mount], check=True, stdout=subprocess.DEVNULL)
    output = ROOT / 'desktop-preview'
    output.mkdir(exist_ok=True)
    receipt = {
        'schemaVersion': 1, 'sourceRevision': revision, 'version': config['version'],
        'architecture': args.architecture, 'bundleId': info['CFBundleIdentifier'],
        'signing': 'ad-hoc; not Developer ID signed or notarized',
        'installer': {'name': dmg.name, 'size': dmg.stat().st_size, 'sha256': digest(dmg)},
        'bundleFiles': inventory(app),
        'checks': ['identity', 'embedded source revision', 'architecture', 'microphone purpose',
                   'signature', 'portable dependencies', 'DMG integrity', 'exact installed bundle'],
        'acceptance': 'Packaging checks only; not GUI, microphone, provider or venue acceptance.',
    }
    import shutil
    shutil.copyfile(dmg, output / dmg.name)
    receipt_name = f'macos-{args.architecture}-receipt.json'
    (output / receipt_name).write_text(json.dumps(receipt, indent=2) + '\n')
    (output / f'SHA256SUMS-{args.architecture}').write_text(
        f'{digest(output / dmg.name)}  {dmg.name}\n'
        f'{digest(output / receipt_name)}  {receipt_name}\n')
    print(json.dumps({key: receipt[key] for key in ['sourceRevision', 'version', 'architecture', 'installer']}))

if __name__ == '__main__':
    main()
