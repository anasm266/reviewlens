"""
Generate simple PNG icons for the ReviewLens extension.
Uses only Python stdlib — no third-party packages needed.
Run once from the project root: python generate-icons.py
"""
import struct
import zlib
import os

def make_png(width, height, r, g, b):
    def chunk(tag, data):
        c = tag + data
        return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c) & 0xFFFFFFFF)

    sig = b'\x89PNG\r\n\x1a\n'
    ihdr = chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0))

    raw = b''
    for _ in range(height):
        raw += b'\x00' + bytes([r, g, b]) * width

    idat = chunk(b'IDAT', zlib.compress(raw, 9))
    iend = chunk(b'IEND', b'')
    return sig + ihdr + idat + iend

os.makedirs('extension/assets', exist_ok=True)

# Amazon orange #FF9900
for size in [16, 48, 128]:
    data = make_png(size, size, 255, 153, 0)
    path = f'extension/assets/icon-{size}.png'
    with open(path, 'wb') as f:
        f.write(data)
    print(f'Created {path}')

print('Done. Replace with real icons before publishing to stores.')
