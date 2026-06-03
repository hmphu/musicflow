"""
Run this script once to generate the icon PNG files.
Requires Pillow: pip install Pillow
"""
import os, struct, zlib

def make_png(size):
    """Create a minimal green music-note PNG without Pillow."""
    # We'll create a simple solid green (#1db954) square PNG
    width = height = size
    raw_rows = []
    for y in range(height):
        row = b'\x00'  # filter type None
        for x in range(width):
            # Draw a simple rounded background + music note shape
            # Use green for the whole icon (simple approach)
            cx, cy = width / 2, height / 2
            r = width * 0.45
            dx, dy = x - cx, y - cy
            dist = (dx*dx + dy*dy) ** 0.5
            if dist < r:
                # Green accent color #1db954
                row += bytes([0x1d, 0xb9, 0x54, 0xFF])
            else:
                # Dark background #0d0d0d
                row += bytes([0x0d, 0x0d, 0x0d, 0xFF])
        raw_rows.append(row)

    raw_data = b''.join(raw_rows)
    compressed = zlib.compress(raw_data, 9)

    def chunk(name, data):
        c = name + data
        return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)

    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0))
    png += chunk(b'IDAT', compressed)
    png += chunk(b'IEND', b'')
    return png

os.makedirs('icons', exist_ok=True)

for size in [16, 48, 128]:
    data = make_png(size)
    path = f'icons/icon{size}.png'
    with open(path, 'wb') as f:
        f.write(data)
    print(f'Created {path}')

print('Done! Icons created in icons/ folder.')
