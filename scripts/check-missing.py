#!/usr/bin/env python3
"""Fix missing keys in locale files."""
import sys

def get_keys(path):
    keys = {}
    for line in open(path).read().split('\n'):
        line = line.strip()
        if line.startswith('"') and '":' in line:
            key = line.split('"')[1]
            keys[key] = line
    return keys

en_file = 'docs/translations.en.js'
en_keys = get_keys(en_file)
print(f'English: {len(en_keys)} keys')

for code in sys.argv[1:]:
    f = f'docs/translations.{code}.js'
    data = open(f).read()
    keys = get_keys(f)
    missing = sorted(set(en_keys.keys()) - set(keys.keys()))
    extra = sorted(set(keys.keys()) - set(en_keys.keys()))
    
    # Show missing keys with their English values
    if missing:
        print(f'\n{code}: missing {len(missing)} keys:')
        for k in missing[:5]:
            print(f'  {k}: {en_keys[k][:80]}')
        if len(missing) > 5:
            print(f'  ... and {len(missing)-5} more')
    
    if extra:
        print(f'\n{code}: extra {len(extra)} keys:')
        for k in extra[:5]:
            print(f'  {k}')
