#!/usr/bin/env python3
"""Check which keys are missing from partial locale files vs English."""
import sys

def get_keys(path):
    keys = set()
    for line in open(path).read().split('\n'):
        line = line.strip()
        if line.startswith('"') and '":' in line:
            key = line.split('"')[1]
            keys.add(key)
    return keys

en_keys = get_keys('docs/translations.en.js')
print(f'English: {len(en_keys)} keys')

for code in sys.argv[1:]:
    keys = get_keys(f'docs/translations.{code}.js')
    missing = sorted(en_keys - keys)
    extra = sorted(keys - en_keys)
    status = "OK" if not missing and not extra else "MISSING"
    print(f'{code}: {len(keys)} keys {status}')
    if missing:
        print(f'  missing ({len(missing)}): {", ".join(missing[:10])}{"..." if len(missing)>10 else ""}')
    if extra:
        print(f'  extra: {", ".join(extra)}')
