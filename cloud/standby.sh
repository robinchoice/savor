#!/usr/bin/env bash
# Warm standby between two Savor instances, see README, "Warm standby". The owner, the host of the newest
# restic snapshot tagged `lease`, is the only one that works; a handover names the backup to bring in.
#
# Run as the user Savor runs as. Savor runs either as a systemd user unit, which this script stops and
# starts, or as a system unit (Savor Cloud), whose process it ends so that systemd starts it again.
# take and give only prepare a change; `tick`, from a timer or cron every minute and outside Savor's
# service, applies it. So both can be run from a conversation or terminal in Savor itself.
set -euo pipefail
shopt -s inherit_errexit

export PATH=$HOME/.local/bin:$PATH:/usr/local/bin:/usr/bin:/bin
# Snapshot times in UTC, so the newest is the greatest on both instances.
export TZ=UTC
SAVOR_HOME=${SAVOR_HOME:-$HOME/.savor}
STATE=$SAVOR_HOME/state.json
# RESTIC_REPOSITORY, RESTIC_PASSWORD and the S3 keys as `export NAME=value` lines; only restic reads them.
CONF=$HOME/.config/savor-standby/env
# Next to state.json, so that a new one replaces it with a rename.
DIR=$SAVOR_HOME/standby
NAME=${SAVOR_STANDBY_NAME:-$(hostname -s)}
UNIT=savor.service
EVERY=900
# A take or give waits this long before Savor restarts, so the conversation that started it can answer.
SETTLE=${SAVOR_STANDBY_SETTLE:-30}
RESTIC_VERSION=0.19.1
RESTIC_SHA256=f415415624dcc452f2a02b8c33641791a8c6d6d3b65bbb3543fcf9a25151585c

log() { echo "savor-standby: $*" >&2; }
die() { log "$*"; exit 1; }
r() { (if [ -f "$CONF" ]; then . "$CONF"; fi; exec restic --quiet "$@"); }
lock() { mkdir -p "$DIR" && exec 9>"$DIR/lock" && flock "$@" 9; }
now() { date +%s; }
age() { echo $(($(now) - $(stat -c %Y "$1"))); }

# The newest snapshot with tag $1 as "id host time", optionally for host $2.
newest() {
  r snapshots --tag "$1" --json | jq -r --arg host "${2:-}" '
    map(select($host == "" or .hostname == $host)) | max_by(.time) // empty | "\(.id) \(.hostname) \(.time)"'
}
holder() { newest lease | cut -d' ' -f2; }
# Makes $1 the owner; $2 is the backup it is to bring in, if any.
claim_for() {
  printf '%s\n' "${2:-}" | r backup --host "$1" --tag lease --stdin --stdin-filename handoff >/dev/null
  [ "$(holder)" = "$1" ] || die "ownership update is not current; check both hosts' clocks"
}
# The backup the current lease hands over.
handoff() {
  local lease id
  lease=$(newest lease)
  read -r id _ <<<"$lease" || true
  [ -z "${id:-}" ] || r dump "$id" /handoff
}

user_unit() { systemctl --user cat "$UNIT" >/dev/null 2>&1; }
active() { if user_unit; then systemctl --user is-active --quiet "$UNIT"; else systemctl is-active --quiet "$UNIT"; fi; }
stop_savor() {
  if user_unit; then systemctl --user stop "$UNIT"; return; fi
  local pid i
  pid=$(systemctl show -p MainPID --value "$UNIT")
  [ "${pid:-0}" -gt 0 ] || return 0
  kill "$pid" 2>/dev/null || return 0
  for i in $(seq 600); do kill -0 "$pid" 2>/dev/null || return 0; sleep 0.1; done
  kill -9 "$pid" 2>/dev/null || true
}
start_savor() { if user_unit; then systemctl --user start --no-block "$UNIT"; fi; }

# Replaces the travelling fields of state.json with those in $1, while Savor is stopped.
merge_state() {
  jq -s '(.[0] | del(.agent, .fallback)) + (.[1] | with_entries(select(.value != null)))' "$STATE" "$1" >"$STATE.standby"
  chmod 600 "$STATE.standby"
  mv -f "$STATE.standby" "$STATE"
}

https_url() {
  case $1 in
    git@*:*) local u=${1#git@}; echo "https://${u%%:*}/${u#*:}" ;;
    ssh://*) local u=${1#ssh://}; u=${u#*@}; echo "https://$u" ;;
    *) echo "$1" ;;
  esac
}

# Backs up the work of the projects in state file $1: their .savor folders and a manifest with what
# travels from state.json, the projects with where they are and where their git remote is. A standby
# that took the work over leaves out the projects it has of its own.
backup() {
  local src=$1 stage=$DIR/stage own='[]' projects='[]' paths=() id path remote project local_state project_state
  local_state=$(realpath "$SAVOR_HOME")
  [ -f "$DIR/own-state.json" ] && own=$(jq -c '[.projects[].id]' "$DIR/own-state.json")
  rm -rf "$stage" && mkdir -p "$stage"
  jq -c --argjson own "$own" '.projects[] | select(.id as $i | $own | index($i) | not)' "$src" >"$DIR/project-list.json"
  while IFS= read -r project; do
    id=$(jq -er .id <<<"$project")
    path=$(jq -er .path <<<"$project")
    [ -d "$path/.savor" ] || continue
    project_state=$(realpath "$path/.savor")
    if [[ -L "$path/.savor" || "$local_state" == "$project_state" || "$local_state" == "$project_state/"* ]]; then
      die "project $id overlaps or links to machine state"
    fi
    remote=$(git -C "$path" remote get-url origin 2>/dev/null || true)
    case $remote in
      http*://*@*|*\?*|*\#*) remote='' ;;
    esac
    projects=$(jq -c --arg id "$id" --arg path "$path" --arg remote "$remote" '. + [{id: $id, path: $path, remote: $remote}]' <<<"$projects")
    paths+=("$path/.savor")
  done <"$DIR/project-list.json"
  jq --argjson projects "$projects" '{projects: $projects, presets, agent, fallback}' "$src" >"$stage/manifest.json"
  local id_written
  id_written=$(r backup --host "$NAME" --tag staging --exclude processes.json --exclude '*.damaged' --exclude '*.tmp' \
    --json "$stage" "${paths[@]}" | jq -er 'select(.message_type == "summary") | .snapshot_id')
  r tag --set state "$id_written"
  local snapshot
  snapshot=$(newest state "$NAME")
  printf '%s\n' "${snapshot%% *}" >"$DIR/last-backup"
  touch "$DIR/backed-up"
  if [ ! -f "$DIR/pruned" ] || [ "$(age "$DIR/pruned")" -ge 86400 ]; then
    r forget --tag state --group-by tags --keep-within 2d --keep-daily 30 --prune --cleanup-cache
    r forget --tag lease --group-by tags --keep-last 10
    r forget --tag staging --group-by tags --keep-within 1d
    touch "$DIR/pruned"
  fi
}

# Puts the work of backup $1 in place: each project's .savor into the folder this instance has for it,
# else into a new folder, cloned from its remote. The .savor it replaces is kept in standby/previous.
# Conversations lose their agent sessions, worktrees and running turns, which were the other instance's.
# Writes standby/incoming.json with the fields of state.json that travel.
restore() {
  local tmp=$DIR/restore manifest mapped='[]' id src remote target project f
  rm -rf "$tmp"
  mkdir -p "$tmp" "$DIR/previous"
  find "$DIR/previous" -mindepth 1 -maxdepth 1 -type d ! -name "$1" -exec rm -rf -- {} +
  r restore "$1" --target "$tmp"
  manifest=$(find "$tmp" -path '*/standby/stage/manifest.json' -print -quit)
  jq -ce '.projects | arrays' "$manifest" >"$DIR/project-list.json"
  while IFS= read -r project; do
    id=$(jq -er .id <<<"$project")
    [[ "$id" =~ ^[a-zA-Z0-9_-]+$ ]] || die "invalid project identifier"
    src=$(jq -er .path <<<"$project")
    remote=$(jq -er .remote <<<"$project")
    target=$(jq -r --arg id "$id" '.projects[] | select(.id == $id) | .path' "$STATE")
    if [ -f "$DIR/primary" ]; then
      target=${target:-$HOME/dev/$(basename "$src")-$id}
    else
      target=$HOME/standby-projects/$id
    fi
    if [ ! -d "$target" ]; then
      if [ -z "$remote" ] || ! GIT_TERMINAL_PROMPT=0 git clone --quiet --filter=blob:none -- "$(https_url "$remote")" "$target"; then
        log "no repository for $target, its conversations are there without code"
        mkdir -p "$target"
      fi
    fi
    for f in "$tmp$src"/.savor/threads/*/thread.json; do
      [ -f "$f" ] || continue
      jq '.agentSessions = [] | .worktree = null | .workingSince = null | .restarts = null | .resumeAt = null
        | .apiCredit = null | .ciWatch = null | if .fork then .fork.sessionId = null else . end' "$f" >"$f.standby"
      mv -f "$f.standby" "$f"
    done
    jq --arg path "$target" '.path = $path' "$tmp$src/.savor/project.json" >"$tmp$src/.savor/project.json.standby"
    mv -f "$tmp$src/.savor/project.json.standby" "$tmp$src/.savor/project.json"
    if [ -d "$target/.savor" ]; then
      mkdir -p "$DIR/previous/$1"
      if [ -d "$DIR/previous/$1/$id" ]; then
        rm -rf "$target/.savor"
      else
        mv "$target/.savor" "$DIR/previous/$1/$id"
      fi
    fi
    mv "$tmp$src/.savor" "$target/.savor"
    mapped=$(jq -c --arg id "$id" --arg path "$target" '. + [{id: $id, path: $path}]' <<<"$mapped")
  done < <(jq -c '.[]' "$DIR/project-list.json")
  jq --argjson projects "$mapped" '{projects: $projects, presets, agent, fallback}' "$manifest" >"$DIR/incoming.json"
  rm -rf "$tmp"
}

# Applies a prepared take or give: Savor stops, state.json gets the fields in standby/pending.json and
# Savor starts again. A give then backs up the work it gave and hands it back.
apply() {
  local to
  stop_savor
  [ ! -f "$DIR/give-to" ] || cp "$STATE" "$DIR/given-state.json"
  merge_state "$DIR/pending.json"
  rm -f "$DIR/pending.json" "$DIR/backed-up"
  start_savor
  if [ -f "$DIR/give-to" ]; then
    to=$(cat "$DIR/give-to")
    backup "$DIR/given-state.json"
    claim_for "$to" "$(cat "$DIR/last-backup")"
    rm -f "$DIR/give-to" "$DIR/given-state.json" "$DIR/own-state.json" "$DIR/taken-from"
    log "gave the work back to $to"
  fi
}

cmd_install() {
  install -D -m755 "$0" "$HOME/.local/bin/savor-standby"
  if ! restic version 2>/dev/null | grep -q "$RESTIC_VERSION"; then
    local tmp
    tmp=$(mktemp -d)
    curl -fsSL -o "$tmp/restic.bz2" "https://github.com/restic/restic/releases/download/v$RESTIC_VERSION/restic_${RESTIC_VERSION}_linux_amd64.bz2"
    echo "$RESTIC_SHA256  $tmp/restic.bz2" | sha256sum -c --quiet - || die "wrong checksum for restic"
    bunzip2 -c "$tmp/restic.bz2" >"$tmp/restic"
    install -D -m755 "$tmp/restic" "$HOME/.local/bin/restic"
    rm -rf "$tmp"
  fi
  mkdir -p "$DIR" "$(dirname "$CONF")"
  local units=$HOME/.config/systemd/user
  if user_unit; then
    mkdir -p "$units/$UNIT.d"
    printf '%s\n' '[Unit]' 'Description=Savor warm standby' '[Service]' 'Type=oneshot' 'ExecStart=%h/.local/bin/savor-standby tick' >"$units/savor-standby.service"
    printf '%s\n' '[Unit]' 'Description=Savor warm standby every minute' '[Timer]' 'OnBootSec=1min' 'OnUnitActiveSec=1min' '[Install]' 'WantedBy=timers.target' >"$units/savor-standby.timer"
    printf '%s\n' '[Service]' 'ExecStartPre=%h/.local/bin/savor-standby may-start' 'TimeoutStartSec=20min' >"$units/$UNIT.d/standby.conf"
    systemctl --user daemon-reload
    systemctl --user enable --now savor-standby.timer
  else
    command -v crontab >/dev/null || die "no crontab here; run 'savor-standby tick' every minute some other way"
    { crontab -l 2>/dev/null | grep -v savor-standby || true; echo "* * * * * $HOME/.local/bin/savor-standby tick >>$DIR/log 2>&1"; } | crontab -
  fi
  log "installed for $NAME; credentials go into $CONF"
}

cmd_init() {
  lock
  r cat config >/dev/null 2>&1 || r init
  local h
  h=$(holder)
  [ -z "$h" ] || [ "$h" = "$NAME" ] || die "$h owns the repository"
  [ -n "$h" ] || claim_for "$NAME"
  touch "$DIR/primary"
}

cmd_status() {
  local id host time snapshot
  echo "this instance: $NAME ($([ -f "$DIR/primary" ] && echo primary || echo standby), Savor $(active && echo running || echo stopped))"
  snapshot=$(newest lease)
  read -r id host time <<<"$snapshot" || true
  echo "owner: ${host:-none} since ${time:-}"
  snapshot=$(newest state)
  read -r id host time <<<"$snapshot" || true
  if [ -n "${id:-}" ]; then echo "newest backup: ${id:0:8} from $host, $((($(now) - $(date -d "$time" +%s)) / 60)) minutes ago"; else echo "newest backup: none"; fi
  if [ -f "$DIR/pending.json" ]; then echo "pending: Savor here restarts within a minute"; fi
}

cmd_copy() {
  local id dest=${1:?supply an empty destination folder}
  local snapshot
  snapshot=$(newest state)
  read -r id _ <<<"$snapshot" || true
  [ -n "$id" ] || die "there is no backup yet"
  mkdir -m 700 -- "$dest"
  r restore "$id" --target "$dest"
}

cmd_take() {
  lock
  [ ! -f "$DIR/primary" ] || die "run take on the standby"
  [ ! -f "$DIR/pending.json" ] || die "a change is pending, Savor restarts within a minute"
  local h id host time minutes snapshot
  h=$(holder)
  [ "$h" != "$NAME" ] || die "$NAME already owns the shared projects"
  [ -n "$h" ] || die "the repository has no owner"
  snapshot=$(newest state "$h")
  read -r id host time <<<"$snapshot" || true
  [ -n "${id:-}" ] || die "$h has no backup to take over"
  minutes=$((($(now) - $(date -d "$time" +%s)) / 60))
  [ "${1:-}" = --force ] || [ "$minutes" -ge 20 ] ||
    die "$h backed up $minutes minutes ago and seems to be working. Stop Savor there, or take over anyway with: savor-standby take --force"
  restore "$id"
  claim_for "$NAME"
  if [ ! -f "$DIR/own-state.json" ]; then
    jq '{projects, presets, agent, fallback}' "$STATE" >"$DIR/own-state.tmp"
    mv -f "$DIR/own-state.tmp" "$DIR/own-state.json"
  fi
  printf '%s\n' "$h" >"$DIR/taken-from"
  mv -f "$DIR/incoming.json" "$DIR/pending.json"
  log "$NAME owns the work of $h from $minutes minutes ago; Savor here restarts within a minute"
}

cmd_give() {
  lock
  [ -f "$DIR/own-state.json" ] || die "there is no takeover to give back"
  [ ! -f "$DIR/pending.json" ] || die "a change is pending, Savor restarts within a minute"
  [ "$(holder)" = "$NAME" ] || die "$NAME doesn't own the shared projects"
  cp "$DIR/taken-from" "$DIR/give-to"
  cp "$DIR/own-state.json" "$DIR/pending.json"
  log "within a minute Savor here restarts with its own projects and $(cat "$DIR/give-to") gets the work back"
}

# The primary takes the work back when the standby can't give it: with the standby's newest backup, if any.
cmd_claim() {
  lock
  [ -f "$DIR/primary" ] || die "only the primary claims; a standby takes over with take"
  local h snapshot id
  h=$(holder)
  [ "$h" != "$NAME" ] || die "$NAME already owns the shared projects"
  snapshot=$(newest state "$h")
  read -r id _ <<<"$snapshot" || true
  claim_for "$NAME" "${id:-}"
  start_savor
  log "$NAME owns the shared projects again; $h goes back to its own projects within a minute"
}

cmd_tick() {
  lock -n || exit 0
  if [ -f "$DIR/log" ] && [ "$(stat -c %s "$DIR/log")" -gt 1000000 ]; then
    tail -n 2000 "$DIR/log" >"$DIR/log.1" && mv -f "$DIR/log.1" "$DIR/log"
  fi
  if [ -f "$DIR/pending.json" ]; then
    if [ "$(age "$DIR/pending.json")" -ge "$SETTLE" ]; then apply; fi
    return 0
  fi
  local h
  h=$(holder)
  if [ "$h" != "$NAME" ]; then
    # Someone else works: a standby goes back to its own projects at once, a primary stops.
    if [ -n "$h" ] && [ -f "$DIR/own-state.json" ]; then
      log "$h owns the shared projects now, going back to the projects of $NAME"
      cp "$DIR/own-state.json" "$DIR/pending.json"
      rm -f "$DIR/own-state.json" "$DIR/taken-from"
      apply
    elif [ -n "$h" ] && [ -f "$DIR/primary" ] && user_unit && active; then
      log "$h owns the shared projects, stopping Savor here"
      stop_savor
    fi
    return 0
  fi
  if ! active; then
    # The work came back, or Savor didn't start while the lease couldn't be read: ExecStartPre does the rest.
    if [ -f "$DIR/primary" ] && user_unit; then
      local id
      id=$(handoff)
      if { [ -n "$id" ] && [ "$id" != "$(cat "$DIR/restored" 2>/dev/null)" ]; } || systemctl --user is-failed --quiet "$UNIT"; then
        systemctl --user reset-failed "$UNIT" 2>/dev/null || true
        start_savor
      fi
    fi
    return 0
  fi
  if [ ! -f "$DIR/backed-up" ] || [ "$(age "$DIR/backed-up")" -ge "$EVERY" ]; then backup "$STATE"; fi
}

cmd_may_start() {
  lock
  local h='' i id
  [ -f "$DIR/primary" ] || return 0
  for i in $(seq 24); do
    if h=$(holder 2>/dev/null); then break; fi
    [ "$i" -lt 24 ] || die "can't read the owner, Savor stays stopped"
    sleep 5
  done
  [ "$h" = "$NAME" ] || die "owner is ${h:-unset}; Savor stays stopped"
  id=$(handoff)
  if [ -z "$id" ] || [ "$id" = "$(cat "$DIR/restored" 2>/dev/null)" ]; then return 0; fi
  restore "$id"
  merge_state "$DIR/incoming.json"
  printf '%s\n' "$id" >"$DIR/restored"
  rm -f "$DIR/backed-up" "$DIR/incoming.json"
  log "brought in the work of backup ${id:0:8}"
}

umask 077
case ${1:-} in
  install|init|status|copy|take|give|claim|tick|may-start)
    command=${1//-/_}
    shift
    "cmd_$command" "$@"
    ;;
  *) die "usage: savor-standby install|init|status|copy DIR|take [--force]|give|claim|tick|may-start" ;;
esac
