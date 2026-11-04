#!/usr/bin/env bash
# Creates the Savor Cloud instance of one customer in the Hetzner project of the instances: a server in
# Germany with Hetzner backups, set up by cloud-init with cloud/install.sh, behind a firewall without a
# single inbound rule, not even SSH. Savor connects out to the relay. No SSH key goes on the server.
#
#   with-secret HCLOUD_PLEASANCE_KUNDEN_TOKEN HCLOUD_TOKEN=HCLOUD_PLEASANCE_KUNDEN_TOKEN -- \
#     cloud/new-instance.sh [--dry-run] [--type <server type>] <customer> [solo|pro]
#
# solo is a CX23, pro a CX33. --type takes another one when Hetzner has none of those, e.g. CAX (Arm).
# --dry-run checks everything and prints the calls that would create the firewall and the server.
#
# The server gets its relay key and setup code from here, so the setup link is known right away. It goes into
# a page with its QR code in ~/.local/state/savor-cloud, readable by this user only and never printed. The
# customer's first device pairs with it once Savor is up and becomes the owner; then the code is spent.
set -euo pipefail
here=$(dirname "$0")

usage() { echo "Usage: $0 [--dry-run] [--type <server type>] <customer> [solo|pro]" >&2; exit 2; }
fail() { echo "$*" >&2; exit 1; }

dry= type=
while [ $# -gt 0 ]; do
  case $1 in
    --dry-run) dry=1; shift ;;
    --type) [ $# -ge 2 ] || usage; type=$2; shift 2 ;;
    -*) usage ;;
    *) break ;;
  esac
done
[ $# -ge 1 ] && [ $# -le 2 ] || usage
name=$1 plan=${2:-solo}
case $plan in
  solo) type=${type:-cx23} ;;
  pro) type=${type:-cx33} ;;
  *) usage ;;
esac
[[ $name =~ ^[a-z][a-z0-9-]{0,62}$ ]] || fail "The customer's name becomes the server's host name: lowercase letters, digits and hyphens."
for tool in hcloud jq openssl xxd basenc node; do command -v "$tool" >/dev/null || fail "Needs $tool."; done
node --input-type=module -e 'import "qrcode-generator"' >/dev/null
[ -n "${HCLOUD_TOKEN:-}" ] || fail "Needs HCLOUD_TOKEN: with-secret HCLOUD_PLEASANCE_KUNDEN_TOKEN HCLOUD_TOKEN=HCLOUD_PLEASANCE_KUNDEN_TOKEN -- $0 …"

# Makes a call that creates something, quietly; a dry run prints it instead.
run() {
  if [ -n "$dry" ]; then printf '+'; printf ' %q' "$@"; echo; else "$@" >/dev/null; fi
}

hcloud server list -o json | jq -e --arg n "$name" 'any(.[]; .name == $n)' >/dev/null && fail "A server $name exists already."
# A firewall of that name without rules is left from a run that failed after it; anything else is not ours.
rules=$(hcloud firewall list -o json | jq -r --arg n "$name" '.[] | select(.name == $n) | .rules | length')
[ -z "$rules" ] || [ "$rules" = 0 ] || fail "A firewall $name with rules exists already."

# Germany only: Nuremberg like kunde0, else Falkenstein.
types=$(hcloud server-type list -o json)
jq -e --arg t "$type" 'any(.[]; .name == $t)' <<<"$types" >/dev/null || fail "Hetzner has no server type $type."
location=$(jq -r --arg t "$type" '.[] | select(.name == $t) | [.locations[] | select(.available) | .name] as $a
  | ["nbg1", "fsn1"] | map(select(IN($a[]))) | first // empty' <<<"$types")
if [ -z "$location" ]; then
  memory=$(jq -r --arg t "$type" '.[] | select(.name == $t) | .memory' <<<"$types")
  echo "Hetzner has no $type in Germany right now (nbg1, fsn1). Others with ${memory} GB there, net per month without IPv4:" >&2
  jq -r --argjson m "$memory" '.[] | select(.memory == $m and (.deprecated | not) and (.name | test("^(cax|cpx|cx)")))
    | . as $s | [.locations[] | select(.available and IN(.name; "nbg1", "fsn1")) | .name] as $a | select($a | length > 0)
    | "  \(.name): \(.architecture), \(.cores) vCPU, \(.disk) GB, \($s.prices[] | select(.location == $a[0]) | .price_monthly.net | tonumber * 100 | round / 100) € in \($a | join(", "))"' <<<"$types" >&2
  fail "Try again later, or pass one of them with --type (CAX is Arm, CPX costs more than CX)."
fi

# The daemon's X25519 key for the relay and its public half, base64url without padding like Savor writes
# them. openssl reads a raw private key only with its PKCS#8 header in front.
key=$(openssl rand -hex 32)
identity=$(xxd -r -p <<<"$key" | basenc --base64url | tr -d '=')
public=$(xxd -r -p <<<"302e020100300506032b656e04220420$key" | openssl pkey -inform DER -pubout -outform DER | tail -c 32 | basenc --base64url | tr -d '=')
code=$(openssl rand -hex 16 | tr a-f A-F)
expires=$(node -e 'console.log(Date.now() + 24 * 60 * 60_000)')
link="https://savor.diespaetzles.lol/#/rpair/$public/$code"

[ -n "$rules" ] || run hcloud firewall create --name "$name" --label "plan=$plan"
# Without an SSH key Hetzner makes a root password; it goes nowhere, reset-password makes a new one.
# The key and the code go in as variables in the second line of install.sh.
run hcloud server create --name "$name" --type "$type" --image ubuntu-24.04 --location "$location" \
  --enable-backup --firewall "$name" --label "plan=$plan" \
  --user-data-from-file <(head -1 "$here/install.sh"; echo "SAVOR_IDENTITY=$identity SAVOR_SETUP_CODE=$code SAVOR_SETUP_EXPIRES=$expires"; tail -n +2 "$here/install.sh")
[ -n "$dry" ] && { echo "Dry run: $type in $location, nothing created." >&2; exit 0; }

page=${XDG_STATE_HOME:-$HOME/.local/state}/savor-cloud/$name.html
install -d -m 700 "$(dirname "$page")"
# The link goes in on stdin: arguments are visible to every user in the process list.
(umask 077 && cd "$here/.." && node --input-type=module -e '
  import fs from "node:fs"
  import qrcode from "qrcode-generator"
  const name = process.argv[1]
  const link = fs.readFileSync(0, "utf8").trim()
  const q = qrcode(0, "M")
  q.addData(link)
  q.make()
  console.log(`<!doctype html><meta charset="utf-8"><title>Savor Cloud: ${name}</title>
<body style="font: 16px system-ui; max-width: 32em; margin: 2em auto">
<h1>Savor Cloud: ${name}</h1>
<p>Once Savor is up, about 20 minutes after the server was created, scan this with the Savor app or the
phone camera, or open the link. The first device becomes the owner; the link works once, for 24 hours after creation.</p>
${q.createSvgTag({ cellSize: 6, margin: 4 })}
<p style="word-break: break-all"><a href="${link}">${link}</a></p>`)
' "$name" <<<"$link" >"$page")

ip=$(hcloud server ip "$name")
cat <<EOF
Created $name: $type in $location, $ip, backups on, no inbound traffic.
cloud-init installs Savor now, which takes about 20 minutes. Then the setup link lets the customer's first
device in as the owner, once, for 24 hours after creation. The link and its QR code, for the customer only: $page
If that pairing fails, Savor makes a new setup code on its next start. Nothing reaches the server, so read it
in Hetzner's console:
  1. hcloud server reset-password $name   (a new root password, for you only)
  2. Hetzner Cloud Console, project of the instances, $name, Console: log in as root with it
  3. systemctl restart savor; journalctl -u savor -g 'Setup link'
EOF
