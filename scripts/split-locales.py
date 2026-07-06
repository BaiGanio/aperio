#!/usr/bin/env python3
"""Split combined translations-data.js into per-locale files."""
import os

data = open('/tmp/translations-data.js').read()

locales = {
    'en': (9, 297),
    'bg': (298, 586),
    'nl': (587, 875),
    'pl': (876, 1164),
    'sk': (1165, 1453),
    'sl': (1454, 1742),
    'sv': (1743, 2031),
    'it': (2033, 2321),
    'pt': (2322, 2610),
}

lines = data.split('\n')
docs_dir = 'docs'

for code, (start, end) in locales.items():
    content_lines = lines[start-1:end]
    inner_lines = content_lines[1:-1]
    out = 'window.__APERIO_LANGS = window.__APERIO_LANGS || {};\n'
    out += f'window.__APERIO_LANGS["{code}"] = {{\n'
    for l in inner_lines:
        out += l + '\n'
    out += '};\n'
    filepath = os.path.join(docs_dir, f'translations.{code}.js')
    with open(filepath, 'w') as f:
        f.write(out)
    count = len([l for l in inner_lines if ':' in l])
    print(f'{filepath}: {count} keys')
