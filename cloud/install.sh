#!/usr/bin/env bash
# Sets up a Savor Cloud instance on a fresh Ubuntu 24.04 server: Node, git, gh, Chromium for the
# preview, the agents' CLIs (unmodified; the customer signs in to them in Savor's terminal) and Savor
# as a service on 127.0.0.1 that connects out to the relay. Nothing listens on the internet but SSH.
#
#   hcloud server create --image ubuntu-24.04 --user-data-from-file cloud/install.sh ...
#
# or run it as root on the server. It can run again. Savor is built from the newest release tag that
# carries Robin's signature, by the savor-update it installs; a timer runs that every night.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
# systemd and the firewall are missing in a container, where this script is tested.
booted() { [ -d /run/systemd/system ]; }

apt-get update
apt-get install -y ca-certificates curl git gnupg build-essential python3 gh jq sudo ufw unattended-upgrades

# Node 24 from NodeSource, updated by unattended-upgrades like the system's security patches, which
# reboot the server at 04:00 when they need to. Savor continues the turns a reboot cuts off.
install -d -m 755 /etc/apt/keyrings
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
echo 'deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main' >/etc/apt/sources.list.d/nodesource.list
cat >/etc/apt/apt.conf.d/52savor <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
Unattended-Upgrade::Origins-Pattern { "site=deb.nodesource.com"; };
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "04:00";
EOF
apt-get update
apt-get install -y nodejs

# Builds of the web app need more than the 4 GB of the smallest server.
if [ ! -f /swapfile ] && booted; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >>/etc/fstab
fi

if booted; then
  ufw allow OpenSSH
  ufw --force enable
fi

id savor >/dev/null 2>&1 || useradd -m -s /bin/bash savor
as_savor() { sudo -iu savor bash -c "$1"; }

# The agents live in the user's home, so they can update themselves.
as_savor 'npm config set prefix ~/.local && mkdir -p ~/.local/bin'
as_savor 'curl -fsSL https://claude.ai/install.sh | bash'
as_savor 'npm install -g --no-fund --no-audit @openai/codex opencode-ai'
# Robin signs the release tags with this key; savor-update builds nothing else.
as_savor 'curl -fsSL https://github.com/robinchoice.gpg | gpg --batch --import'

cat >/usr/local/bin/savor-update <<'EOF'
#!/usr/bin/env bash
# Builds the newest signed Savor release into ~/savor/releases/<tag>, points ~/savor/current at it and
# updates the agents' CLIs. The running Savor sees current/package.json change (SAVOR_EXIT_ON_UPDATE),
# gives working agents five minutes and exits; systemd starts the new version.
set -euo pipefail
[ "$(id -un)" = savor ] || exec sudo -iu savor "$0" "$@"
KEY=0AFDD4D64A9C88CA79406F3F830E8CDEA8C84A38
ROOT=~/savor
mkdir -p "$ROOT/releases"
[ -d "$ROOT/repo" ] || git clone --quiet --bare https://github.com/robinchoice/savor.git "$ROOT/repo"
git -C "$ROOT/repo" fetch --quiet --force origin 'refs/tags/v*:refs/tags/v*'
npm install -g --no-fund --no-audit @openai/codex@latest opencode-ai@latest >/dev/null

tag=$(git -C "$ROOT/repo" tag --list 'v*' --sort=-v:refname | head -1)
[ "$(readlink "$ROOT/current" || true)" = "releases/$tag" ] && exit 0
git -C "$ROOT/repo" verify-tag --raw "$tag" 2>&1 | grep -q "VALIDSIG $KEY " || { echo "$tag is not signed with $KEY" >&2; exit 1; }

dir=$ROOT/releases/$tag
rm -rf "$dir" && mkdir -p "$dir"
git -C "$ROOT/repo" archive "$tag" | tar -x -C "$dir"
(cd "$dir" && npm ci --no-fund --no-audit && npm run build && node node_modules/playwright-core/cli.js install chromium)
ln -sfn "releases/$tag" "$ROOT/current.new" && mv -T "$ROOT/current.new" "$ROOT/current"
echo "Savor $tag installed"
# Keep the release before as a way back.
ls -1 "$ROOT/releases" | sort -V | head -n -2 | while read -r old; do rm -rf "${ROOT:?}/releases/$old"; done
EOF
chmod 755 /usr/local/bin/savor-update
savor-update
node /home/savor/savor/current/node_modules/playwright-core/cli.js install-deps chromium

cat >/etc/systemd/system/savor.service <<'EOF'
[Unit]
Description=Savor
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
User=savor
WorkingDirectory=/home/savor/savor/current
Environment=PATH=/home/savor/.local/bin:/usr/local/bin:/usr/bin:/bin
Environment=SAVOR_EXIT_ON_UPDATE=/home/savor/savor/current/package.json
# Until the customer's first device is in, each start logs a setup code that lets it in as the owner.
Environment=SAVOR_SETUP=1
ExecStart=/usr/bin/node dist/server/index.mjs
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
cat >/etc/systemd/system/savor-update.service <<'EOF'
[Unit]
Description=Build the newest signed Savor release

[Service]
Type=oneshot
User=savor
Environment=PATH=/home/savor/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/local/bin/savor-update
EOF
cat >/etc/systemd/system/savor-update.timer <<'EOF'
[Unit]
Description=Update Savor every night

[Timer]
OnCalendar=*-*-* 03:00
RandomizedDelaySec=30m
Persistent=true

[Install]
WantedBy=timers.target
EOF
if booted; then
  systemctl daemon-reload
  systemctl enable --now savor.service savor-update.timer
fi
echo 'Savor Cloud is set up. Open it through an SSH tunnel: ssh -L 4317:127.0.0.1:4317 root@<server>, then the link with the token from: journalctl -u savor | grep token='
