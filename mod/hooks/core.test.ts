import { expect, test } from 'claude-code/testing'
import { type Applied, type Kind, type Ops, advice, ambiguous, apply, changed, created, flagged, fresh, match, near, ops, search, shell, shellEdit, split, sync, writes } from './core'

const lcs = (a: string[], b: string[]) => {
  const t = a.map(() => new Array(b.length + 1).fill(0)).concat([new Array(b.length + 1).fill(0)])
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--) t[i]![j] = a[i] === b[j] ? t[i + 1]![j + 1]! + 1 : Math.max(t[i + 1]![j]!, t[i]![j + 1]!)
  return t[0]![0]!
}

test('myers keeps a longest common subsequence', async () => {
  let seed = 7
  const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2147483648) % n)
  for (let round = 0; round < 500; round++) {
    const a = Array.from({ length: rnd(12) }, () => 'abcd'[rnd(4)]!)
    const b = Array.from({ length: rnd(12) }, () => 'abcd'[rnd(4)]!)
    const m = match(a, b)
    let last = -1, kept = 0
    m.forEach((i, j) => {
      if (i < 0) return
      expect(a[i]).toBe(b[j])
      expect(i > last).toBe(true)
      last = i, kept++
    })
    expect(kept).toBe(lcs(a, b))
  }
})

test('anchors are unique and survive edits; only new lines get new ones', async () => {
  // IDs: unique, all above the line count, not in line order
  const big = fresh(Array.from({ length: 300 }, (_, i) => `l${i}`))
  expect(new Set(big.anchors).size).toBe(300)
  expect(big.anchors.every(a => Number(a) > 600)).toBe(true)
  expect(big.anchors.slice(0, 3).map(Number)).not.toEqual([601, 602, 603])
  const st = sync(undefined, split('a\nb\nc\nd\n').lines)
  const [A, B, C, D] = st.anchors
  const out = (apply(st, [{ from: B, to: C, text: 'x\ny\nz\n' }, { before: A, text: 'top' }]) as Applied).lines
  expect(out).toEqual(['top', 'a', 'x', 'y', 'z', 'd'])
  const next = sync(st, out)
  expect([next.anchors[1], next.anchors[5]]).toEqual([A, D])
  expect(changed(st, next).split('\n').length).toBe(6) // top, a, x, y, z, d: new lines and a neighbour either side
  expect(apply(next, [{ from: B, text: '' }])).toMatch(/unknown anchor/)
  expect(apply(next, [{ from: A, to: D, text: '' }, { after: A, text: 'q' }])).toBe('edits overlap')
  // an outside edit moves lines; anchors follow the text, not the line number
  expect(sync(next, ['new', ...out]).anchors.slice(1)).toEqual(next.anchors)
})

test('find/replace, pasted anchors, duplicate warnings, search, stale recovery', async () => {
  const st = sync(undefined, ['def f(env):', '    x = os.environ.get("A")', '    return x', '', 'y = os.environ.get("B")'])
  const [F, X, R, , Y] = st.anchors
  expect((apply(st, [{ find: 'os.environ.get(', replace: 'os.getenv(' }]) as Applied).lines.filter(l => l.includes('getenv')).length).toBe(2)
  expect((apply(st, [{ from: F, to: R, find: 'environ.get', replace: 'getenv' }]) as Applied).lines[4]).toContain('environ.get')
  expect(apply(st, [{ find: 'nope', replace: 'x' }])).toMatch(/not found/)
  expect((apply(st, [{ from: R, text: `${R}§    return x or 1` }]) as Applied).lines[2]).toBe('    return x or 1')
  expect((apply(st, [{ from: R, text: '    x = os.environ.get("A")\n    return x' }]) as Applied).warnings[0]).toMatch(/repeats the line above/)
  expect((apply(st, [{ after: X, text: 'y = 2' }]) as Applied).warnings[0]).toMatch(/not indented/)
  expect((apply(st, [{ after: R, text: 'def g():\n    pass' }]) as Applied).warnings).toEqual([])
  expect((apply(st, [{ from: F, text: 'def f(env, y):' }]) as Applied).warnings).toEqual([]) // top-level line stays top-level
  expect((apply(st, [{ from: '2', find: 'environ.get', replace: 'getenv' }]) as Applied).lines[1]).toContain('getenv')
  expect(apply(st, [{ from: '2', text: 'z' }])).toMatch(/unknown anchor/) // numbers only where find validates
  expect(apply(st, [{ from: '3', find: 'environ', replace: 'x' }])).toMatch(/not found/)
  expect(apply(st, [{ from: '5', find: 'environ', replace: 'x' }])).not.toBe('ambiguous') // line 5 by number, ok
  // the file grows past its smallest ID: a number could be either, so it is refused, and a re-anchor never reuses IDs
  const grown = sync(st, [...st.lines, ...Array.from({ length: 110 }, () => 'z = 0')])
  expect(ambiguous(grown)).toBe(true)
  const small = grown.anchors.find(a => Number(a) <= grown.lines.length)!
  expect(apply(grown, [{ from: small, text: 'q' }])).toMatch(/both an anchor and a line number/)
  const re = fresh(grown.lines, grown.minted)
  expect(re.anchors.some(a => grown.anchors.includes(a))).toBe(false)
  expect(ambiguous(re)).toBe(false)
  expect((apply(st, [{ find: '    return x\n\ny', replace: '    return x\ny' }]) as Applied).lines.length).toBe(4) // find spans lines
  // several finds over one range chain in order: two renames in a file are one call
  expect((apply(st, [{ find: 'os.environ.get(', replace: 'os.getenv(' }, { find: 'def f(', replace: 'def g(' }]) as Applied).lines.slice(0, 2)).toEqual(['def g(env):', '    x = os.getenv("A")'])
  expect(apply(st, [{ find: 'environ', replace: 'x' }, { find: 'x.get', replace: 'y' }, { find: 'nope', replace: 'z' }])).toMatch(/"nope" not found/)
  expect(apply(st, [{ find: 'environ', replace: 'x' }, { from: R, text: 'z' }])).toMatch(/^edits overlap: a find edit/)
  expect(search(st, /environ/, 0).hits).toBe(2)
  expect(search(st, /environ/, 0).text).toBe(`${X}§    x = os.environ.get("A")\n…\n${Y}§y = os.environ.get("B")`)
  const moved = sync(st, ['# header', 'def f(env):', '    x = os.getenv("A")', '    return x', '', 'y = os.environ.get("B")'])
  expect(near(st, moved, X!)).toContain('os.getenv')
})

// ---- whole files ----

const DISK: Record<string, Kind> = { 'a.ts': 'file', 'b.ts': 'file', src: 'dir', 'src/x.ts': 'file' }
const sort = (edits: Parameters<typeof ops>[0], path = '') => ops(edits, path, p => DISK[p])

test('a call sorts into creates, deletes, renames and line edits', async () => {
  const o = sort([
    { path: 'new/c.ts', text: 'export const c = 1\n' },
    { path: './a.ts', delete: true },
    { path: 'b.ts', rename: 'lib//b.ts', find: 'x', replace: 'y' },
    { path: 'src/x.ts', from: '7', text: 'z' },
    { path: 'src/', rename: 'source' },
  ]) as Ops
  expect([...o.create]).toEqual([['new/c.ts', 'export const c = 1\n']])
  expect(o.remove).toEqual(['a.ts'])
  expect([...o.move]).toEqual([['b.ts', 'lib/b.ts'], ['src', 'source']])
  // the line edits keep nothing of the file operation they came with
  expect([...o.groups]).toEqual([['b.ts', [{ find: 'x', replace: 'y' }]], ['src/x.ts', [{ from: '7', text: 'z' }]]])
  expect((sort([{ text: '' }], 'empty.txt') as Ops).create.get('empty.txt')).toBe('')
  expect((sort([{ delete: 'true' as unknown as boolean }], 'a.ts') as Ops).remove).toEqual(['a.ts'])
})

test('a file operation that cannot stand refuses the call and says why', async () => {
  expect(sort([{ text: 'x' }])).toBe('each edit needs a path, or give one path for all of them')
  expect(sort([{ text: 'x' }], 'a.ts')).toContain('a.ts: exists already')
  expect(sort([{ text: 'x' }], 'src')).toContain('src: exists already')
  expect(sort([{ path: 'n.ts', text: 'x' }, { path: './n.ts', text: 'y' }])).toBe('n.ts: created twice')
  expect(sort([{ path: 'n.ts', text: 'x' }, { path: 'n.ts', find: 'x', replace: 'y' }])).toContain('n.ts: no such file')
  expect(sort([{ delete: true }], 'gone.ts')).toBe('gone.ts: no such file to delete')
  expect(sort([{ delete: true }], 'src')).toBe('src: is a directory; delete takes one file')
  expect(sort([{ path: 'a.ts', delete: true }, { path: 'a.ts', find: 'x', replace: 'y' }])).toContain('a.ts: delete takes the file whole')
  expect(sort([{ path: 'a.ts', delete: true }, { path: 'a.ts', rename: 'c.ts' }])).toContain('a.ts: delete takes the file whole')
  expect(sort([{ rename: 'c.ts' }], 'gone.ts')).toBe('gone.ts: no such file to rename')
  expect(sort([{ rename: 'b.ts' }], 'a.ts')).toBe('a.ts: cannot rename to b.ts, which exists; delete that first')
  expect(sort([{ rename: './a.ts' }], 'a.ts')).toBe('a.ts: rename needs another path')
  expect(sort([{ rename: '' }], 'a.ts')).toBe('a.ts: rename needs another path')
  expect(sort([{ path: 'a.ts', rename: 'c.ts' }, { path: 'b.ts', rename: 'c.ts' }])).toContain('b.ts: cannot rename to c.ts')
  expect(sort([{ path: 'a.ts', rename: 'c.ts' }, { path: 'c.ts', text: 'x' }])).toBe('c.ts: created twice')
  expect(sort([{ path: 'a.ts', rename: 'c.ts' }, { path: 'a.ts', rename: 'd.ts' }])).toBe('a.ts: renamed twice')
  expect(sort([{ from: '3', text: 'x' }], 'gone.ts')).toBe('gone.ts: no such file ({path, text} alone creates one)')
  expect(sort([{ from: '3', text: 'x' }], 'src')).toBe('src: is a directory; line edits take a file')
})

test('a new file comes back with its IDs: whole when short, head and tail when long', async () => {
  const short = fresh(['a', 'b', 'c'])
  expect(created(short).split('\n').map(l => l.split('§')[1])).toEqual(['a', 'b', 'c'])
  const long = fresh(Array.from({ length: 200 }, (_, i) => `line ${i}`)), out = created(long).split('\n')
  expect(out.length).toBe(12)
  expect(out[0]).toBe(`${long.anchors[0]}§line 0`)
  expect(out[10]).toBe(`${long.anchors[199]}§line 199`)
  expect(out[11]).toBe('[200 lines; read with pattern for the IDs between]')
})

// ---- shell edits ----

test('a shell command splits into commands, redirect targets and heredoc bodies', async () => {
  const flat = (cmd: string) => shell(cmd).map(s => [s.words.map(w => w.t).join(' '), s.outs.map(w => w.t).join(' '), s.piped, s.doc].filter(x => x !== '' && x !== undefined && x !== false))
  expect(flat(`git commit -m "a && b; c | d > e" && echo 'it''s' >> "out file" 2>&1`)).toEqual([['git commit -m a && b; c | d > e'], ['echo its', 'out file']])
  expect(flat('cat <<-\'EOF\' > a.txt | wc -l\n\tx && y\n\tEOF\necho $(ls | wc -l) 2> err.log')).toEqual([['cat', 'a.txt', '\tx && y'], ['wc -l', true], ['echo $(ls | wc -l)']])
  expect(flat('a \\\n  b # sed -i\nc &> all.log & d')).toEqual([['a b'], ['c', 'all.log'], ['d']])
  expect(shell('echo "$HOME"/x \'$HOME\' *.ts a.ts').flatMap(s => s.words.map(w => w.dyn))).toEqual([false, true, false, true, false])
  // a substitution is one piece of its word, in quotes or out of them, with the quotes, operators and heredocs it holds
  expect(flat(`git commit -m "$(cat <<'EOF'\nsay "a; b | c > d" (once)\nEOF\n)" && ls`)).toEqual([[`git commit -m $(cat <<'EOF'\nsay "a; b | c > d" (once)\nEOF\n)`], ['ls']])
  expect(flat(`echo "$(echo ")" ')' \\) "$(echo ';')")" > out; x=$(a "b)" | c) d`)).toEqual([[`echo $(echo ")" ')' \\) "$(echo ';')")`, 'out'], ['x=$(a "b)" | c) d']])
  expect(flat('echo "$(unclosed "quote; ls')).toEqual([['echo $(unclosed "quote; ls']])
  // a target written with ">>" is marked: it is added to, never emptied
  expect(shell(': > a; : >> b; x &>> c').flatMap(s => s.outs.map(w => [w.t, w.add ?? false]))).toEqual([['a', false], ['b', true], ['c', true]])
})

/** Whether the command is flagged in a session at /repo; `none` says no file it names exists yet. */
const hit = (cmd: string, none = false) => {
  const v = shellEdit(cmd)
  return v !== undefined && flagged(v, '/repo', ['/repo'], () => !none)
}

const EDITS = [
  `sed -i 's/foo/bar/g' src/app.ts`,
  `sed -i '' 's/foo/bar/g' src/app.ts`,
  `sed -i.bak -e 's/DEBUG = True/DEBUG = False/' settings.py`,
  `sed -E -i 's/v[0-9]+/v2/' README.md`,
  `sed -i -e '1d' -e '$d' notes.md`,
  `sed --in-place 's/a/b/' x.txt`,
  `gsed -ni '/keep/p' list.txt`,
  `grep -rl oldName src | xargs sed -i 's/oldName/newName/g'`,
  `grep -rlZ foo . | xargs -0 -n 20 sed -i '' -e 's/foo/bar/g'`,
  `find . -name '*.py' -exec sed -i 's/import foo/import bar/' {} +`,
  `for f in $(git ls-files '*.ts'); do sed -i '' "s/foo/bar/g" "$f"; done`,
  `cd packages/core && sed -i 's/1.0.0/1.0.1/' package.json`,
  `npm run build && sed -i 's/localhost/0.0.0.0/' dist/config.js`,
  `bash -c "sed -i 's/a/b/' f.txt"`,
  `sudo sed -i 's/a/b/' conf/app.ini`,
  `perl -pi -e 's/foo/bar/g' lib/*.pm`,
  `perl -i -pe 's/\\bfoo\\b/bar/g' src/main.c`,
  `perl -0777 -i -pe 's/a\\nb/c/' file.txt`,
  `perl -pi.bak -e 's/x/y/' a.txt`,
  `ruby -pi -e 'gsub(/foo/, "bar")' config.rb`,
  `awk -i inplace '{gsub(/foo/,"bar")}1' file.txt`,
  `python3 -c "import pathlib; p=pathlib.Path('src/app.py'); p.write_text(p.read_text().replace('foo','bar'))"`,
  `python -c "s=open('a.txt').read(); open('a.txt','w').write(s.replace('x','y'))"`,
  `python3 -c 'import re,sys\nf=sys.argv[1]\ns=open(f).read()\nopen(f, "w").write(re.sub(r"v\\d+", "v2", s))' README.md`,
  `python3 - <<'EOF'\nimport re\npath = 'src/app.py'\nwith open(path) as f:\n    s = f.read()\ns = re.sub(r'foo\\(', 'bar(', s)\nwith open(path, 'w') as f:\n    f.write(s)\nEOF`,
  `python3 <<EOF\nfrom pathlib import Path\nPath("x.md").write_text("hi")\nEOF`,
  `python3 -c "import fileinput\nfor line in fileinput.input('a.txt', inplace=True): print(line.replace('a','b'), end='')"`,
  `python3 -c "import io; p = 'notes.md'; io.open(p, mode='a', encoding='utf-8').write('x')"`,
  `python3 -c "import gzip; gzip.open('data.txt.gz', 'wt').write('x')"`,
  `uv run python -c "import sys; open(sys.argv[1], 'w').write('x')" out.txt`,
  `node -e "const fs=require('fs');const f='package.json';const j=JSON.parse(fs.readFileSync(f));j.version='2.0.0';fs.writeFileSync(f,JSON.stringify(j,null,2))"`,
  `node --input-type=module -e "import {writeFileSync,readFileSync} from 'fs'; writeFileSync('a.js', readFileSync('a.js','utf8').replace('var ','let '))"`,
  `node <<'EOF'\nconst fs = require('node:fs/promises')\nconst file = 'CHANGELOG.md'\nawait fs.appendFile(file, 'x')\nEOF`,
  `bun -e "await Bun.write('out.txt', (await Bun.file('out.txt').text()).replaceAll('a','b'))"`,
  `ruby -e 'File.write("a.rb", File.read("a.rb").gsub("x","y"))'`,
  `ruby -e 'File.open(ARGV[0], "w") { |f| f.puts 1 }' a.txt`,
  `ed -s file.txt <<'EOF'\n,s/foo/bar/g\nw\nq\nEOF`,
  `printf '%s\\n' '1d' 'w' 'q' | ed -s notes.txt`,
  `ex -sc '%s/foo/bar/g|x' file.txt`,
  `vim -es -c '%s/foo/bar/g' -c 'wq' file.txt`,
  `echo "export FOO=1" >> .env`,
  `cat > src/config.ts <<'EOF'\nexport const x = 1\nEOF`,
  `cat <<EOF > README.md\n# Title\nEOF`,
  `printf 'a\\nb\\n' > list.txt`,
  `echo "node_modules" | tee -a .gitignore`,
  `cat <<'EOF' | sudo tee config/app.yml\nkey: v\nEOF`,
  `tee src/x.txt <<'EOF'\nhello\nEOF`,
  `sed 's/foo/bar/' a.txt > a.tmp && mv a.tmp a.txt`,
  `jq '.version = "2.0.0"' package.json > tmp.json && mv -f tmp.json package.json`,
  `(cd docs; echo "- item" >> TODO.md)`,
  // through the wrappers the setting's description names, their own options included
  `env -i sed -i 's/a/b/' README.md`,
  `env -u FOO BAR=1 sed -i 's/a/b/' README.md`,
  `timeout 5 sed -i 's/a/b/' README.md`,
  `timeout -s KILL 5s sed -i 's/a/b/' README.md`,
  `nice -n 10 sed -i 's/a/b/' README.md`,
  `time sed -i 's/a/b/' README.md`,
  `sudo -u www nohup perl -pi -e 's/a/b/' README.md`,
  `bash -c "echo x > README.md"`,
  `sh -c 'printf "%s\\n" a | tee -a README.md'`,
  // the other tools that write over a file, and what a shell is handed as text
  `yq -i '.a = 1' config.yaml`,
  `yq eval -i '.spec.replicas = 3' deploy/app.yaml`,
  `jq . package.json | sponge package.json`,
  `: > README.md`,
  `> src/app.ts`,
  `npm test; true > notes.txt`,
  `truncate -s 0 README.md`,
  `truncate --size=0 a.txt b.txt`,
  `bash <<'EOF'\nsed -i 's/a/b/' README.md\nEOF`,
  `sh <<EOF\nnpm run build\necho x >> notes.md\nEOF`,
  `sh -c "bash -c \\"sed -i 's/a/b/' README.md\\""`,
  `eval "sed -i 's/a/b/' README.md"`,
  `echo 'sed -i s/a/b/ README.md' | sh`,
  `cat <<'EOF' | bash -s\nperl -pi -e 's/a/b/' README.md\nEOF`,
  `patch -p1 <<'EOF'\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-a\n+b\nEOF`,
  `git apply <<'EOF'\ndiff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-a\n+b\nEOF`,
  `git apply <<'EOF'\ndiff --git a/README.md b/README.md\nEOF`,
  `sed -n 'w README.md' a.py`,
  `sed -n -e '/^import/w imports.txt' src/app.py`,
  `sed 's/foo/bar/w changed.txt' a.txt`,
  `perl -e 'open(F,">README.md"); print F "x"'`,
  `perl -e 'open(my $f, ">>", "notes.md") or die; print $f "x"'`,
  `php -r 'file_put_contents("README.md", "x");'`,
  `dd if=/dev/null of=README.md`,
  `npx --yes replace-in-file foo bar src/app.ts`,
  `replace-in-file 'old' 'new' 'src/**/*.ts'`,
]

const OTHERS = [
  `prettier --write src`,
  `npx prettier --write "src/**/*.ts"`,
  `black .`,
  `ruff check --fix .`,
  `ruff format src && ruff check`,
  `gofmt -w .`,
  `eslint --fix src`,
  `cargo fmt`,
  `npm install`,
  `pnpm add -D vitest`,
  `pip install -r requirements.txt`,
  `cargo build --release 2>&1 | tail -20`,
  `make -j8`,
  `tsc --noEmit -p .`,
  `docker compose up -d`,
  `git commit -m "fix: use sed -i to patch the config"`,
  `git add -A && git commit -m 'replace foo with bar > baz'`,
  `git diff > /tmp/changes.patch`,
  `git log --oneline | head -20`,
  `git stash && git checkout main`,
  `git commit -F - <<'EOF'\nsubject\n\nopen(path, 'w') was wrong\nEOF`,
  `pytest -x tests/ > test.log 2>&1`,
  `npm test 2>&1 | tee test-output.txt`,
  `npm run build 2>&1 | tee build.log`,
  `go test ./... > /dev/null`,
  `bun test hooks/core.test.ts`,
  `python3 scripts/migrate.py --write`,
  `python3 scripts/fix.py <<'EOF'\nopen('a.txt', 'w')\nEOF`,
  `python3 -m pytest -c pytest.ini`,
  `node scripts/build.js > build.txt`,
  `perl scripts/gen.pl -i input.txt`,
  `python3 -c "print(open('a.txt').read())"`,
  `python3 -c "import json,sys; json.dump({'a':1}, sys.stdout)"`,
  `python3 -c "import subprocess; subprocess.run(['ls'])"`,
  `python3 - <<'EOF'\nimport json\nprint(json.load(open('package.json'))['version'])\nEOF`,
  `python3 -c "import webbrowser, urllib.request; urllib.request.urlopen('http://x/w')"`,
  `node -e "console.log(require('./package.json').version)"`,
  `node -p "process.versions.node"`,
  `ruby -e 'puts File.read("a.rb").lines.count'`,
  `cat <<EOF\nhello > world\nEOF`,
  `cat file.txt | python3 analyze.py > report.md`,
  `echo "done" > /dev/null`,
  `echo "log line" >> /tmp/out.txt`,
  `echo "x" >> ~/.zshrc`,
  `echo hi >&2`,
  `cat > "$TMPDIR/x.txt" <<EOF\nhi\nEOF`,
  `echo $PATH`,
  `sed -n '10,20p' src/app.ts`,
  `sed 's/foo/bar/' a.txt`,
  `sed -e 's/-i/x/' a.txt | head`,
  `sed -i 's/a/b/' /tmp/scratch/notes.txt`,
  `grep -rn "sed -i" docs/`,
  `rg "open\\(.*'w'\\)" src`,
  `echo "sed -i 's/a/b/' file"`,
  `perl -ne 'print if /foo/' file.txt`,
  `perl -MList::Util=sum -e 'print sum(1..10)'`,
  `awk '{print $1}' data.csv | sort | uniq -c`,
  `curl -s https://example.com/api > response.json`,
  `ls -la > files.txt`,
  `mv old.txt new.txt`,
  `rm -rf dist && mkdir -p src/a && touch src/a/b.ts`,
  `find . -name '*.pyc' -delete`,
  `find . -name '*.ts' -exec grep -l foo {} +`,
  `xargs -n1 basename < list.txt`,
  `ssh host "sed -i 's/a/b/' /etc/x"`,
  `docker exec app sed -i 's/a/b/' /etc/x`,
  `jq . package.json`,
  `vim file.txt`,
  `wc -l src/*.ts 2>/dev/null`,
  // text inside "$( … )" is the word's, never commands: a commit message or a PR body that quotes shell text
  `git commit -m "$(cat <<'EOF'\nDocument the "echo x; sed -i s/a/b/ README.md" idiom\nEOF\n)"`,
  `gh pr create --title t --body "$(cat <<'EOF'\n1) run "sed -i s/a/b/ README.md"\n2) echo done > README.md\nEOF\n)"`,
  `git commit -m "$(printf 'a "b" (c) d; sed -i s/a/b/ README.md')" && echo ok`,
  `git commit -F - <<'EOF'\nsubject\n\necho x > README.md; sed -i s/a/b/ README.md\nEOF`,
  // a script that writes where its arguments or its own arithmetic say, into a temp folder or outside the project
  `python3 -c "import sys; open(sys.argv[1],'w').write('x')" /tmp/out.txt`,
  `python3 - <<'EOF'\nimport csv, tempfile, os\nout = os.path.join(tempfile.mkdtemp(), 'fixture.csv')\nwith open(out, 'w') as f:\n    csv.writer(f).writerow([1,2])\nprint(out)\nEOF`,
  `python3 -c "import json; d = json.load(open('package.json')); json.dump(d, open('/tmp/report.json','w'))"`,
  `python3 -c "import io; io.open(p, mode='a', encoding='utf-8').write('x')"`,
  `python3 -c "import pathlib, tempfile; (pathlib.Path(tempfile.gettempdir()) / 'r.txt').write_text('x')"`,
  `node -e "require('fs').writeFileSync('/tmp/o.json','{}')"`,
  `node <<'EOF'\nconst fs = require('node:fs/promises')\nawait fs.appendFile(file, 'x')\nEOF`,
  `node -e "require('fs').writeFileSync(process.argv[1], 'x')" "$TMPDIR/o.txt"`,
  `ruby -e 'File.write(ARGV[0], "x")' /tmp/o.txt`,
  // x.open(…, 'w') of a module that is no file of text: only a path spelled out inside the project counts
  `python3 -c "import gzip; gzip.open('/tmp/a.gz','wt').write('x')"`,
  `python3 -c "import tarfile; tarfile.open('/tmp/x.tar','w').close()"`,
  `python3 -c "import shelve; shelve.open('/tmp/s','w')"`,
  `python3 -c "import wave; wave.open('/tmp/a.wav','w')"`,
  `python3 -c "import gzip; gzip.open(name, 'wt').write('x')"`,
  `python3 -c "import zipfile; zipfile.ZipFile(out, 'w').close(); db.open('w')"`,
  // a wrapper's own options are not the command's
  `env -i npm test`,
  `timeout 30 npm run build`,
  `command -v sed`,
  // near the tools that write over a file: the same ones reading, checking, adding nothing, or writing outside the project
  `yq '.a' config.yaml`,
  `yq -o json . config.yaml`,
  `yq -i '.a = 1' /tmp/scratch.yaml`,
  `jq . package.json | sponge /tmp/pretty.json`,
  `npm test | sponge test.log`,
  `sponge --help`,
  `: >> README.md`,
  `: > /tmp/scratch.txt`,
  `> build.log`,
  `: > "$OUT"`,
  `true && echo ok`,
  `find . -name '*.ts' > files.txt`,
  `truncate -s 10M disk.img`,
  `truncate -s 0 /tmp/x.txt`,
  `truncate -s 0 app.log`,
  `bash <<'EOF'\nnpm test\ngit status\nEOF`,
  `bash scripts/run.sh <<'EOF'\nsed -i 's/a/b/' README.md\nEOF`,
  `sh -c 'npm run build'`,
  `eval "$(ssh-agent -s)"`,
  `eval "$(direnv hook bash)" && npm test`,
  `echo "sed -i 's/a/b/' README.md" | cat`,
  `echo 'sed -i s/a/b/ README.md' | ssh host sh`,
  `curl -fsSL https://example.com/install.sh | sh`,
  `echo 'npm test' | sh`,
  `patch -p1 --dry-run <<'EOF'\n--- a/README.md\n+++ b/README.md\nEOF`,
  `patch -p0 <<'EOF'\n--- /tmp/x.txt\n+++ /tmp/x.txt\nEOF`,
  `git apply --check <<'EOF'\ndiff --git a/README.md b/README.md\nEOF`,
  `git apply --stat fix.patch`,
  `git diff | git apply --cached`,
  `sed -n '/now w/p' a.txt`,
  `sed 's/a/w b/g' a.txt`,
  `sed -n 'w /tmp/copy.txt' a.py`,
  `sed -n '/x/w /dev/stdout' a.py`,
  `perl -e 'open(F, "<README.md"); print <F>'`,
  `perl -e 'open(my $f, ">", $ARGV[0]); print $f "x"' /tmp/x`,
  `perl -e 'open(F, ">/tmp/out.txt"); print F 1'`,
  `perl -e 'open(STDOUT, ">&STDERR"); print 1 > 0'`,
  `php -r 'echo file_get_contents("README.md");'`,
  `php -r 'file_put_contents("/tmp/o.txt", "x");'`,
  `php -r 'file_put_contents($argv[1], "x");' out.txt`,
  `php artisan migrate`,
  `dd if=README.md of=/dev/null`,
  `dd if=/dev/zero of=/tmp/disk.img bs=1M count=10`,
  `dd if=README.md bs=1 count=10`,
  `npx replace-in-file foo bar src/app.ts --dry`,
  `npx prettier --write src/app.ts`,
  `cp a.py b.py`,
]

/** Rewrites only when the file is there: the same commands onto a new file are how files get made. */
const ONTO_NEW = [
  `echo hello > new-file.txt`,
  `cat > src/new.ts <<'EOF'\nexport {}\nEOF`,
  `printf '%s\\n' a b | tee list.txt`,
  `python3 -c "import json; json.dump({'a': 1}, open('out.json', 'w'))"`,
  `node -e "require('fs').writeFileSync('gen.json', '{}')"`,
  `sed 's/a/b/' in.txt > out.txt`,
  `python3 -c "import sys; open(sys.argv[1], 'w').write('x')" out.txt`,
  `python3 -c "import gzip; gzip.open('a.gz', 'wt').write('x')"`,
  `bash -c "echo x > made.txt"`,
  `: > made.txt`, `> made.txt`, `truncate -s 0 made.txt`, `jq -n '{}' | sponge made.json`, `dd if=/dev/zero of=made.img`, `perl -e 'open(F, ">made.txt")'`, `php -r 'file_put_contents("made.txt", "x");'`, `sed -n 'w made.txt' a.py`, `patch -p1 <<'EOF'\n--- /dev/null\n+++ b/made.txt\nEOF`, `sh <<EOF\necho x > made.txt\nEOF`,
]

test('commands that rewrite a file by script are flagged', async () => {
  expect(EDITS.length >= 30).toBe(true)
  expect(EDITS.filter(c => !hit(c))).toEqual([])
})

test('formatters, package managers, git, test runs, prints and scripts from a file are not', async () => {
  expect(OTHERS.length >= 30).toBe(true)
  expect(OTHERS.filter(c => hit(c))).toEqual([])
})

test('a redirect, tee or script naming its file is flagged only onto a file that exists', async () => {
  expect(ONTO_NEW.filter(c => !hit(c))).toEqual([])
  expect(ONTO_NEW.filter(c => hit(c, true))).toEqual([])
  // a sure rewrite needs no look at the disk, and relative paths follow a cd
  expect(hit(`sed -i 's/a/b/' x.txt`, true)).toBe(true)
  expect(hit(`cd /elsewhere && echo x >> notes.md`)).toBe(false)
  expect(hit(`cd /elsewhere && sed -i 's/a/b/' notes.md`)).toBe(false)
  expect(hit(`cd /repo/sub && echo x >> ../notes.md`)).toBe(true)
})

test('a command of any shape is judged at once: no pattern backtracks over a long script, no pipeline is walked twice', async () => {
  const took = (cmd: string) => {
    const t0 = performance.now()
    shellEdit(cmd)
    return performance.now() - t0 < 250 ? 'at once' : `${Math.round(performance.now() - t0)} ms`
  }
  expect(took(`sed -i '${'/'.repeat(40_000)}' a.txt`)).toBe('at once')
  expect(took(Array.from({ length: 20_000 }, () => 'cat').join(' | '))).toBe('at once')
  expect(took(`git commit -m "$(cat <<'EOF'\n${'a "b" (c) | d; '.repeat(20_000)}\nEOF\n)"`)).toBe('at once')
})

test('an inline script writes only where it opens for writing', async () => {
  expect(writes('py', `open('a', 'r'); x.replace(b, 'a')`)).toBeUndefined()
  expect(writes('py', `open(os.path.join(d, 'f, g'), "wb")`)).toEqual([''])
  expect(writes('py', `with open('a.txt', encoding='utf-8', mode='r+') as f: pass`)).toEqual(['a.txt'])
  expect(writes('py', `Path('a.md').write_text(s); p.open('w')`)).toEqual(['a.md'])
  // a path is named by a string, by an argument of the script, by Path('…'), or by a variable set to one of those
  expect(writes('py', `f=sys.argv[1]; open(f, 'w')`, ['README.md'])).toEqual(['README.md'])
  expect(writes('py', `open(sys.argv[2], 'w')`, ['a'])).toEqual([''])
  expect(writes('py', `p = pathlib.Path('a.py')\np.write_text(p.read_text())\nq = Path(d) / 'x'\nq.write_text('')`)).toEqual(['a.py', ''])
  expect(writes('py', `p = Path('a.py'); f = p.open('w'); g = p.open()`)).toEqual(['a.py'])
  expect(writes('py', `for l in fileinput.input('a.txt', inplace=True): pass`)).toEqual(['a.txt'])
  // another module's open counts only with its path spelled out; a receiver that is no path, never
  expect(writes('py', `gzip.open('a.gz', 'wt'); tarfile.open(name, 'w'); shelve.open('w'); codecs.open('b', 'w')`)).toEqual(['a.gz', 'b'])
  expect(writes('js', `const f = 'package.json'; fs.writeFileSync(f, s); fs.writeFileSync(process.argv[1], s)`, ['o.txt'])).toEqual(['package.json', 'o.txt'])
  expect(writes('rb', `File.open(ARGV[0], "w") { }; File.write(ARGV[1], "x")`, ['a.txt'])).toEqual(['', 'a.txt'])
  expect(writes('js', 'fs.writeFileSync(`${dir}/a`, s)')).toEqual([''])
  expect(writes('js', `fs.readFileSync('a'); console.log('writeFileSync')`)).toBeUndefined()
  expect(writes('rb', `File.open("a", "r") { }`)).toBeUndefined()
})

test('the line names the edit call to make, spelled out for a plain substitution', async () => {
  const say = (cmd: string, refused = true) => advice(shellEdit(cmd)!, 'edit', refused)
  expect(say(`sed -i 's/foo/bar/g' src/app.ts`)).toBe('Not run: edit files with edit, not sed -i: {path: "src/app.ts", edits: [{find: "foo", replace: "bar"}]}')
  expect(say(`sed -i '' 's|a/b|c/d|' x y`, false)).toBe('Next time edit files with edit, not sed -i: {path: <file or directory>, edits: [{find: "a/b", replace: "c/d"}]}')
  expect(say(`perl -pi -e 's/colour/color/g;' docs/*.md`)).toContain('{path: <file or directory>, edits: [{find: "colour", replace: "color"}]}')
  expect(say(`python3 -c "import pathlib; p=pathlib.Path('a.py'); p.write_text(p.read_text().replace('foo', 'bar'))"`)).toContain('not a python script: {path: "a.py", edits: [{find: "foo", replace: "bar"}]}')
  // a pattern, a shell variable or several scripts are not spelled out: the model writes its own find
  for (const cmd of [`sed -i 's/v[0-9]+/v2/' a`, `sed -i "s/$OLD/$NEW/" a`, `sed -i -e 's/a/b/' -e 's/c/d/' a`, `sed -i 's/a/\\0b/' a`, `echo x >> a.txt`])
    expect(say(cmd)).toContain('{path: <file or directory>, edits: [{find, replace}]} for a substitution, else IDs from read')
})
