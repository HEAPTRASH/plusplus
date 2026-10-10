#!/usr/bin/env python3
"""Reads plusplus spec packs (.aesp files) without the mod. Python 3.9 or later, standard library only.

  python3 aesp.py dump FILE...     one JSON object per change, one per line, as the mod's text form writes them
  python3 aesp.py verify FILE...   one line per file, "ok" or "FAIL"; exit status 1 if any file fails

The format is specified in the comment at the top of hooks/pack.ts; this file follows it rule for rule.
As a git diff driver:  git config diff.aesp.textconv "python3 -I tools/aesp.py dump"  with  "*.aesp diff=aesp"  in .gitattributes.
"""
import sys

# Python puts the script's own folder first on the import path. This script may sit in, or be run from, a checkout
# nobody has reviewed, so that folder comes off before anything but sys is imported. (-I and -P already leave it out.)
if __name__ == '__main__' and not (sys.flags.isolated or getattr(sys.flags, 'safe_path', False)):
    del sys.path[0]

import hashlib
import json
import os
import re
import zlib

KINDS = ('area', 'spec', 'decision')
STATUSES = ('proposed', 'accepted', 'superseded', 'dropped')
VERSION, BLOCK, BLOCKS, MOST = 1, 256 << 10, 16, 2**53 - 1
LARGEST = 6 + BLOCKS * (10 + BLOCK + BLOCK // 8 + 64)  # no pack is longer: 16 full blocks, each as badly packed as allowed
ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'


class Bad(Exception):
    """What is wrong with a file, in words for the person who has to fix it."""


class Reader:
    def __init__(self, data):
        self.data, self.pos = data, 0

    def left(self):
        return len(self.data) - self.pos

    def take(self, n):
        if n > self.left():
            raise Bad('cut short')
        self.pos += n
        return self.data[self.pos - n:self.pos]

    def int(self):
        value = 0
        for k in range(8):
            b = self.take(1)[0]
            value |= (b & 127) << (7 * k)
            if b < 128:
                if (b == 0 and k > 0) or value > MOST:
                    break
                return value
        raise Bad('a number that is padded, over eight bytes or past 2^53')

    def count(self, least, what):
        n = self.int()
        if n * least > self.left():
            raise Bad(f'{n} {what} cannot fit in the {self.left()} bytes left')
        return n

    def id(self):
        bits = int.from_bytes(self.take(8), 'big')
        return ''.join(ALPHABET[(bits >> shift) & 31] for shift in range(60, -1, -5))


def payload(data):
    """The blocks' raw bytes, joined, each checked against its length and CRC."""
    if len(data) < 6 or data[:5] != b'AESP\0' or data[5] == 0:
        raise Bad('not a pack: it does not open with "AESP", a NUL and a version')
    if data[5] > VERSION:
        raise Bad(f'version {data[5]} is newer than this reader, which reads up to {VERSION}')
    r, parts, b = Reader(data), [], 0
    r.pos = 6
    while r.left() or b == 0:
        if any(len(p) != BLOCK for p in parts):
            raise Bad(f'block {b} follows one that is not full')
        if b == BLOCKS:
            raise Bad(f'more than {BLOCKS} blocks')
        size, packed = r.int(), r.int()
        if not 1 <= size <= BLOCK:
            raise Bad(f'block {b} says it holds {size} bytes; a block holds 1 to {BLOCK}')
        if packed > size + size // 8 + 64:
            raise Bad(f'block {b} is {packed} bytes packed, too many for the {size} it holds')
        crc, stream = int.from_bytes(r.take(4), 'little'), zlib.decompressobj(-15)
        try:
            raw = stream.decompress(r.take(packed), size + 1)
        except zlib.error as e:
            raise Bad(f'block {b} is damaged ({e})')
        if not stream.eof or stream.unused_data:
            raise Bad(f'block {b} is damaged (its stream does not end where the block does)')
        if len(raw) != size:
            raise Bad(f'block {b} holds {len(raw)} bytes and says {size}')
        if zlib.crc32(raw) != crc:
            raise Bad(f'block {b} fails its checksum')
        parts.append(raw)
        b += 1
    return b''.join(parts)


def changes(data):
    """The changes in a pack's bytes, each a dict with its keys in the text form's order."""
    r, strings = Reader(payload(data)), []

    def string(r):
        i = r.int()
        if i >= len(strings):
            raise Bad('a string index past the table')
        return strings[i]

    for i in range(r.count(1, 'strings')):
        try:
            strings.append(r.take(r.int()).decode('utf-8'))
        except UnicodeDecodeError:
            raise Bad(f'string {i} is not UTF-8')
    writers = [(r.take(6).hex(), string(r), string(r)) for _ in range(r.count(8, 'writers'))]
    out, ms = [], 0
    for i in range(r.count(12, 'changes')):
        c = {'id': r.id()}
        ms += r.int()
        if ms > MOST:
            raise Bad(f'change {i} is stamped past 2^53')
        c['at'], w = [ms, r.int()], r.int()
        if w >= len(writers):
            raise Bad(f'change {i} names a writer past the table')
        c['writer'], c['by'], c['via'] = writers[w]
        got = {}
        for _ in range(r.count(2, 'fields')):
            tag, size = r.int(), r.int()
            f = Reader(r.take(size))
            if tag in got and tag != 6:
                raise Bad(f'change {i} gives field {tag} twice')
            if tag == 1:
                got[1] = f.take(1)[0]
            elif tag == 2:
                got[2] = f.id() if size else ''
            elif tag in (3, 4):
                got[tag] = string(f)
            elif tag == 5:
                got[5] = (f.take(1)[0], f.id() if f.left() else None)
            elif tag == 6:
                sign = f.take(1)
                if sign not in (b'+', b'-'):
                    raise Bad(f'change {i} has a ref that is neither added nor removed')
                got.setdefault(6, []).append(sign.decode() + string(f))
            else:
                continue  # a field from a later writer: skipped by its length
            if f.left() or (tag == 1 and got[1] >= len(KINDS)) or (tag == 5 and got[5][0] >= len(STATUSES)):
                raise Bad(f'change {i} has a field {tag} that is not one')
        if 1 in got:
            c['kind'] = KINDS[got[1]]
        for tag, key in ((2, 'under'), (3, 'title'), (4, 'why')):
            if tag in got:
                c[key] = got[tag]
        if 5 in got:
            c['status'] = STATUSES[got[5][0]]
            if got[5][1]:
                c['replacedBy'] = got[5][1]
        if 6 in got:
            c['refs'] = got[6]
        out.append(c)
    if r.left():
        raise Bad(f'{r.left()} bytes after the last change')
    return out


def read(path):
    """A file's bytes and its changes. No more is read than a pack can be."""
    try:
        with open(path, 'rb') as f:
            data = f.read(LARGEST + 1)
    except OSError as e:
        raise Bad(f'cannot be read ({e.strerror})')
    if len(data) > LARGEST:
        raise Bad(f'not a pack: it is over the {LARGEST} bytes a pack can be')
    return data, changes(data)


def say(stream, text):
    """Writes UTF-8 whatever the locale, and a file name that is not text as the bytes it is."""
    stream.buffer.write(text.encode('utf-8', 'surrogateescape'))


def main(argv):
    if len(argv) < 3 or argv[1] not in ('dump', 'verify'):
        say(sys.stderr, 'usage: aesp.py dump FILE...\n       aesp.py verify FILE...\n')
        return 2
    failed = False
    for path in argv[2:]:
        try:
            data, found = read(path)
            # a pack is named by the SHA-256 of its bytes: a name that opens with 16 or more hex digits is held to it
            named = re.match('[0-9a-f]*', os.path.basename(path)).group()[:64]
            if argv[1] == 'verify' and len(named) >= 16 and not hashlib.sha256(data).hexdigest().startswith(named):
                raise Bad(f'is not the file its name says: its bytes hash to {hashlib.sha256(data).hexdigest()[:16]}')
        except Bad as e:
            failed = True
            say(sys.stdout if argv[1] == 'verify' else sys.stderr, f'FAIL {path}: {e}\n')
            continue
        if argv[1] == 'verify':
            say(sys.stdout, f'ok {path}: {len(found)} changes\n')
        else:
            say(sys.stdout, ''.join(json.dumps(c, ensure_ascii=False, separators=(',', ':')) + '\n' for c in found))
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
