#!/usr/bin/env bash
# Creates the Savor Cloud instance of one customer in the Hetzner project of the instances: a server in
# Germany with Hetzner backups, set up by cloud-init with cloud/install.sh, behind a firewall without a
# single inbound rule, not even SSH. Savor connects out to the relay. No SSH key goes on the server.
#
#   with-secret HCLOUD_PLEASANCE_KUNDEN_TOKEN HCLOUD_TOKEN=HCLOUD_PLEASANCE_KUNDEN_TOKEN -- \
#     cloud/new-instance.sh [--dry-run] [--type <server type>] <customer> [solo|pro]
#
# It takes the cheapest server type that is free in Germany with the plan's memory (solo 4 GB, pro 8 GB).
# When that costs more than the plan's budget, it creates nothing and names it; --type <it> takes it anyway,
# as it takes any other type.
# --dry-run checks everything and prints the calls that would create the firewall and the server.
#
# The server gets its relay key and setup code from here, so the setup link is known right away. The link
# goes into Robin's Proton Pass (vault "Savor Cloud", item "Savor Cloud: <customer>") and nowhere else: it
# is never printed or written to a file. The customer's first device pairs with it once Savor is up and
# becomes the owner; then the code is spent. Until then it works for 30 days, and its page shows how long
# the setup still takes. A new link: delete the server before its first pairing and run this again.
set -euo pipefail
here=$(dirname "$0")
VAULT="Savor Cloud"

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
# Memory in GB and the most a server may cost without asking, net per month: CX and CAX fit, CPX doesn't.
case $plan in
  solo) memory=4 budget=7 ;;
  pro) memory=8 budget=11 ;;
  *) usage ;;
esac
[[ $name =~ ^[a-z][a-z0-9-]{0,62}$ ]] || fail "The customer's name becomes the server's host name: lowercase letters, digits and hyphens."
for tool in hcloud jq openssl xxd basenc pass-cli; do command -v "$tool" >/dev/null || fail "Needs $tool."; done
[ -n "${HCLOUD_TOKEN:-}" ] || fail "Needs HCLOUD_TOKEN: with-secret HCLOUD_PLEASANCE_KUNDEN_TOKEN HCLOUD_TOKEN=HCLOUD_PLEASANCE_KUNDEN_TOKEN -- $0 …"
[ -n "$dry" ] || pass-cli vault list >/dev/null 2>&1 || fail "Proton Pass is locked, where the setup link goes. Unlock it (pass-cli session unlock) and run this again."

# Makes a call that creates something, quietly; a dry run prints it instead.
run() {
  if [ -n "$dry" ]; then printf '+'; printf ' %q' "$@"; echo; else "$@" >/dev/null; fi
}

hcloud server list -o json | jq -e --arg n "$name" 'any(.[]; .name == $n)' >/dev/null && fail "A server $name exists already."
# A firewall of that name without rules is left from a run that failed after it; anything else is not ours.
rules=$(hcloud firewall list -o json | jq -r --arg n "$name" '.[] | select(.name == $n) | .rules | length')
[ -z "$rules" ] || [ "$rules" = 0 ] || fail "A firewall $name with rules exists already."

# Germany only, Nuremberg before Falkenstein at the same price. CAX is Arm, which install.sh handles too.
offers=$(hcloud server-type list -o json | jq -c --argjson m "$memory" --arg t "$type" '[.[]
  | select((.deprecated | not) and (.name | test("^(cx|cax|cpx)")) and (if $t == "" then .memory == $m else .name == $t end)) | . as $s
  | .locations[] | select(.available and IN(.name; "nbg1", "fsn1")) | .name as $l
  | {type: $s.name, location: $l, arch: $s.architecture, cores: $s.cores, disk: $s.disk,
     price: ($s.prices[] | select(.location == $l) | .price_monthly.net | tonumber * 100 | round / 100)}]
  | sort_by(.price, .location != "nbg1")')
[ "$(jq length <<<"$offers")" -gt 0 ] || fail "Hetzner has no ${type:-type with $memory GB} free in Germany (nbg1, fsn1) right now. Try again later."
given=$type
read -r type location price < <(jq -r 'first | "\(.type) \(.location) \(.price)"' <<<"$offers")
if [ -z "$given" ] && awk -v p="$price" -v b="$budget" 'BEGIN { exit !(p > b) }'; then
  echo "The cheapest $memory GB server free in Germany costs more than $budget € net a month, the budget of $plan:" >&2
  jq -r '.[] | "  \(.type): \(.arch), \(.cores) vCPU, \(.disk) GB, \(.price) € net in \(.location)"' <<<"$offers" | awk '!seen[$1]++' >&2
  fail "Nothing created. Ask Robin, then take it with --type $type, or try again later."
fi

# The daemon's X25519 key for the relay and its public half, base64url without padding like Savor writes
# them. openssl reads a raw private key only with its PKCS#8 header in front.
key=$(openssl rand -hex 32)
identity=$(xxd -r -p <<<"$key" | basenc --base64url | tr -d '=')
public=$(xxd -r -p <<<"302e020100300506032b656e04220420$key" | openssl pkey -inform DER -pubout -outform DER | tail -c 32 | basenc --base64url | tr -d '=')
code=$(openssl rand -hex 16 | tr a-f A-F)
created=$(date +%s)
expires=$(( (created + 30 * 86400) * 1000 ))
# The creation time lets the link's page tell how long the setup still takes.
link="https://savor.diespaetzles.lol/#/rpair/$public/$code/$created"

# The link goes into Proton Pass first, through stdin like every secret: without it, the server is no use.
if [ -z "$dry" ]; then
  pass-cli vault list --output json | jq -e --arg v "$VAULT" 'any(.. | objects; .name? == $v)' >/dev/null ||
    pass-cli vault create --name "$VAULT" >/dev/null
  pass-cli item trash --vault-name "$VAULT" --item-title "Savor Cloud: $name" >/dev/null 2>&1 || true
  LINK=$link jq -n --arg title "Savor Cloud: $name" \
    --arg note "Setup link of $name ($type, created $(date -d "@$created" '+%F %R')). The first device that opens it becomes the owner: send it to the customer only. It works until then, for 30 days." \
    '{title: $title, note: $note, sections: [{section_name: "Setup", fields: [{field_name: "Link", field_type: "hidden", value: env.LINK}]}]}' |
    pass-cli item create custom --vault-name "$VAULT" --from-template - >/dev/null
fi

[ -n "$rules" ] || run hcloud firewall create --name "$name" --label "plan=$plan"
# Without an SSH key Hetzner makes a root password; it goes nowhere, reset-password makes a new one.
# The key and the code go in as variables in the second line of install.sh.
run hcloud server create --name "$name" --type "$type" --image ubuntu-24.04 --location "$location" \
  --enable-backup --firewall "$name" --label "plan=$plan" \
  --user-data-from-file <(head -1 "$here/install.sh"; echo "SAVOR_IDENTITY=$identity SAVOR_SETUP_CODE=$code SAVOR_SETUP_EXPIRES=$expires"; tail -n +2 "$here/install.sh")
[ -n "$dry" ] && { echo "Dry run: $type in $location for $price € net a month, nothing created." >&2; exit 0; }

cat <<EOF
Created $name: $type in $location ($price € net a month), $(hcloud server ip "$name"), backups on, no inbound traffic.
cloud-init installs Savor now, which takes a few minutes; the setup link's page shows how long it still takes.
The link is in Proton Pass, vault "$VAULT", item "Savor Cloud: $name". Send it to the customer right away.
It lets the first device in as the owner, once, for 30 days. A new one: delete the server before its first
pairing (hcloud server delete $name, the firewall stays) and run this again.
EOF
