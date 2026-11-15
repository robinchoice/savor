#!/usr/bin/env bash
# Comments state the rule, not its history. Fails on references a reader cannot
# resolve from the repo, warns on history narration. Scans the source
# folders without tests, tracked and new files alike.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

# A read loop instead of mapfile, which the bash 3.2 of macOS lacks
files=()
while IFS= read -r f; do
  if [[ -f $f ]]; then files+=("$f"); fi
done < <(
  git ls-files --cached --others --exclude-standard -- server web shared relay desktop bin demo scripts site mobile/*.mjs |
    grep -E '\.(ts|tsx|js|mjs|cjs|css|html)$' |
    grep -vE '\.test\.|/tests?/'
)
[[ ${#files[@]} -eq 0 ]] && exit 0

# file:line:comment, only the part from the comment marker on
comments=$(grep -nHoE '(^|[[:space:]])(//|/\*|<!--).*|^[[:space:]]*\*.*' -- "${files[@]}" || true)
tracked=$(git ls-files --cached --others --exclude-standard)
failed=0

block() {
  local hits
  hits=$(grep -iE "$2" <<<"$comments" || true)
  [[ -z $hits ]] && return
  echo "check-comments: $1" >&2
  echo "$hits" | sed 's/^/  /' >&2
  failed=1
}

block 'issue or PR number' '(^|[^&[:alnum:]])#[0-9]+\b'
block 'path on a developer machine' '(^|[^[:alnum:]])(/home/[^/[:space:]]+|/Users/[^/[:space:]]+)/'
block 'Savor, thread or session ID' '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|(savor|thread|conversation|session)[[:space:]:#-]+[0-9a-f]{6,}\b'

# Markdown files must exist in the repo, so plans and agent notes elsewhere fail. ROLE.md, PROJECT.md
# and tasks.md are files Savor reads and writes in the user's projects.
missing=''
while IFS= read -r line; do
  for doc in $(grep -oE '[[:alnum:]_./-]*[[:alnum:]_-]\.md\b' <<<"${line#*:*:}"); do
    doc=${doc#./}
    [[ $doc =~ ^(ROLE|PROJECT|tasks)\.md$ ]] && continue
    grep -qxE "(.*/)?${doc//./\\.}" <<<"$tracked" || missing+="  $line"$'\n'
  done
done < <(grep -E '\.md\b' <<<"$comments" || true)
if [[ -n $missing ]]; then
  echo "check-comments: Markdown file not in the repo" >&2
  printf '%s' "$missing" >&2
  failed=1
fi

warnings=$(grep -iE '\b(previously|formerly|this used to|it used to|we used to|no longer (needed|used|required|necessary|supported)|the old (code|version|implementation|way|behaviou?r|approach)|früher|jetzt neu|nicht mehr nötig)\b' <<<"$comments" || true)
if [[ -n $warnings ]]; then
  echo "check-comments: warning, history narration (describe the rule, the history is in git)" >&2
  echo "$warnings" | sed 's/^/  /' >&2
fi

[[ $failed -eq 0 ]]
