#!/usr/bin/env python3
"""Build an unsigned, 4-byte aligned APK:  resources.apk (from aapt2) + classes.dex  ->  unsigned.apk
usage: assemble.py <resources.apk> <classes.dex> <out-unsigned.apk>"""
import sys, zipfile, time

src_apk, dex_path, out_path = sys.argv[1:4]
src = zipfile.ZipFile(src_apk)
entries = {i.filename: src.read(i.filename) for i in src.infolist()}
entries['classes.dex'] = open(dex_path, 'rb').read()

# order: manifest, dex, everything under res/, resources.arsc last
names = ['AndroidManifest.xml', 'classes.dex'] + sorted(n for n in entries if n.startswith('res/')) + ['resources.arsc']
assert set(names) == set(entries), (set(entries) ^ set(names))

STORED_EXT = ('.png', '.arsc')      # keep these uncompressed (resources.arsc MUST be stored on targetSdk 30+)
now = time.localtime()[:6]
with zipfile.ZipFile(out_path, 'w') as z:
    for name in names:
        data = entries[name]
        zi = zipfile.ZipInfo(name, date_time=now)
        zi.create_system = 3
        zi.external_attr = 0o644 << 16
        if name.endswith(STORED_EXT):
            zi.compress_type = zipfile.ZIP_STORED
            # pad the local header "extra" field so the file data starts on a 4-byte boundary (zipalign -p 4)
            start = z.fp.tell()
            base = 30 + len(name.encode('utf-8'))
            pad = (-(start + base)) % 4
            zi.extra = b'\x00' * pad
        else:
            zi.compress_type = zipfile.ZIP_DEFLATED
            zi._compresslevel = 9
        z.writestr(zi, data)
print('wrote', out_path, len(names), 'entries')
