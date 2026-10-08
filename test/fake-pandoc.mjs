#!/usr/bin/env node
// Stand-in for pandoc used by the end-to-end tests: `--version` succeeds, and a conversion writes its
// own arguments to the file after -o, so a test can check what Savor passed.
import fs from 'node:fs'

const args = process.argv.slice(2)
if (args[0] === '--version') process.exit(0)
const out = args[args.indexOf('-o') + 1]
fs.writeFileSync(out, args.join('\n'))
process.stderr.write('[WARNING] Citeproc: citation ghost2021 not found\n')
