#!/usr/bin/env python3
"""Print every APK entry with its compression method and whether stored data starts 4-byte aligned."""
import sys, struct, zipfile
path = sys.argv[1]
raw = open(path, 'rb').read()
z = zipfile.ZipFile(path)
bad = 0
for i in z.infolist():
    off = i.header_offset
    sig, = struct.unpack_from('<I', raw, off)
    assert sig == 0x04034b50, 'bad local header'
    nlen, elen = struct.unpack_from('<HH', raw, off + 26)
    data_off = off + 30 + nlen + elen
    aligned = (data_off % 4 == 0)
    stored = i.compress_type == 0
    flag = '' if (not stored or aligned) else '  <-- NOT ALIGNED'
    if flag: bad += 1
    print(f'{i.filename:55s} method={i.compress_type} size={i.file_size:7d} data_off={data_off:7d} mod4={data_off%4}{flag}')
print('zip test:', z.testzip() or 'ok', '| misaligned stored entries:', bad)
sys.exit(1 if bad else 0)
