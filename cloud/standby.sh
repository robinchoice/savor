#!/usr/bin/env bash
# Warm standby between two Savor instances. See README, "Warm standby".
set -euo pipefail
shopt -s inherit_errexit

export PATH=$HOME/.local/bin:$PATH:/usr/local/bin:/usr/bin:/bin
# Snapshot times in UTC, so the newest is the greatest on both instances.
export TZ=UTC
SAVOR_HOME=${SAVOR_HOME:-$HOME/.savor}
STATE=$SAVOR_HOME/state.json
# Next to state.json, so that a new one replaces it with a rename.
DIR=$SAVOR_HOME/standby
NAME=${SAVOR_STANDBY_NAME:-$(hostname -s)}
UNIT=savor.service
EVERY=900
log() { echo "savor-standby: $*" >&2; }
die() { log "$*"; exit 1; }
r() { restic --quiet "$@"; }
lock() { mkdir -p "$DIR" && exec 9>"$DIR/lock" && flock "$@" 9; }
now() { date +%s; }
age() { echo $(($(now) - $(stat -c %Y "$1"))); }

# The newest snapshot with tag $1 as "id host time", optionally for host $2.
newest() {
  r snapshots --tag "$1" --json | jq -r --arg host "${2:-}" '
    map(select($host == "" or .hostname == $host)) | max_by(.time) // empty | "\(.id) \(.hostname) \(.time)"'
}
holder() { newest lease | cut -d' ' -f2; }
claim_for() {
  printf '%s\n' "${2:-}" | r backup --host "$1" --tag lease --stdin --stdin-filename handoff >/dev/null
  [ "$(holder)" = "$1" ] || die "ownership update is not current; check both hosts' clocks"
}

active() { systemctl --user is-active --quiet "$UNIT"; }
stop_savor() { systemctl --user stop "$UNIT"; }

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
# else into the projects folder, cloned from its remote. The .savor it replaces is kept in standby/previous.
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
      if [ -n "$remote" ]; then
        GIT_TERMINAL_PROMPT=0 git clone --quiet --filter=blob:none -- "$(https_url "$remote")" "$target"
      else
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
  echo "this instance: $NAME (Savor $(active && echo running || echo stopped))"
  snapshot=$(newest lease)
  read -r id host time <<<"$snapshot"
  echo "owner: ${host:-none}"
  snapshot=$(newest state)
  read -r id host time <<<"$snapshot"
  echo "newest backup: ${id:-none} $host $time"
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
  [ "${1:-}" = --primary-powered-off ] || die "power off the primary and keep it off before running take --primary-powered-off"
  local h id host
  h=$(holder)
  if [ "$h" = "$NAME" ] && [ -f "$DIR/own-state.json" ]; then
    die "already owns the shared projects"
  fi
  local snapshot
  [ -n "$h" ] || die "the repository has no owner"
  snapshot=$(newest state "$h")
  read -r id host _ <<<"$snapshot" || true
  [ -n "$id" ] && [ "$host" = "$h" ] || die "the owner has no backup to restore"
  stop_savor
  if [ ! -f "$DIR/own-state.json" ]; then
    jq '{projects, presets, agent, fallback}' "$STATE" >"$DIR/own-state.tmp"
    printf '%s\n' "$h" >"$DIR/taken-from"
    mv -f "$DIR/own-state.tmp" "$DIR/own-state.json"
  fi
  restore "$id"
  merge_state "$DIR/incoming.json"
  claim_for "$NAME"
  rm -f "$DIR/backed-up" "$DIR/incoming.json"
}

cmd_give() {
  lock
  [ -f "$DIR/own-state.json" ] || die "there is no takeover to give back"
  local h to
  h=$(holder)
  to=$(cat "$DIR/taken-from")
  stop_savor
  if [ "$h" = "$NAME" ]; then
    backup "$STATE"
    claim_for "$to" "$(cat "$DIR/last-backup")"
  else
    [ "$h" = "$to" ] || die "unexpected owner: $h"
  fi
  merge_state "$DIR/own-state.json"
  rm -f "$DIR/own-state.json" "$DIR/taken-from"
}

cmd_tick() {
  lock -n || exit 0
  active || return 0
  [ "$(holder)" = "$NAME" ] || return 0
  if [ ! -f "$DIR/backed-up" ] || [ "$(age "$DIR/backed-up")" -ge "$EVERY" ]; then backup "$STATE"; fi
}

cmd_may_start() {
  lock
  local lease lease_id h id
  if [ ! -f "$DIR/primary" ] && [ ! -f "$DIR/own-state.json" ]; then return 0; fi
  lease=$(newest lease)
  read -r lease_id h _ <<<"$lease" || true
  [ "$h" = "$NAME" ] || die "owner is ${h:-unset}; Savor stays stopped"
  [ -f "$DIR/primary" ] || return 0
  id=$(r dump "$lease_id" /handoff)
  if [ -z "$id" ] || [ "$id" = "$(cat "$DIR/restored" 2>/dev/null)" ]; then return 0; fi
  restore "$id"
  merge_state "$DIR/incoming.json"
  printf '%s\n' "$id" >"$DIR/restored"
  rm -f "$DIR/backed-up" "$DIR/incoming.json"
}

umask 077
case ${1:-} in
  init|status|copy|take|give|tick|may-start)
    command=${1//-/_}
    shift
    "cmd_$command" "$@"
    ;;
  *) die "usage: savor-standby init|status|copy DIR|take --primary-powered-off|give|tick|may-start" ;;
esac
