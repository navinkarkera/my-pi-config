#!/usr/bin/env bash
# herdr-launcher.sh — Launch mind + TUI workers via herdr panes.
# Called by bin/mind-worker-launcher when terminalBackend == "herdr" in mind-worker.json.
# Workers run as TUI (not --mode rpc). Mind-worker extension (PI_MIND_WORKER_ROLE env)
# handles the rest via control-file protocol.
#
# Uses only herdr-skill-documented commands: pane list, pane split, pane run, pane close.
set -euo pipefail

# ── Guard: must run inside herdr ──
if [ "${HERDR_ENV:-}" != "1" ]; then
	echo "ERROR: herdr-launcher must run inside a herdr-managed pane (HERDR_ENV=1)" >&2
	exit 1
fi

# ── Paths ──
AGENT_DIR="${HOME}/.pi/agent"
STATE_DIR="${AGENT_DIR}/mindworker"
SESSIONS_DIR="${AGENT_DIR}/sessions"
CONFIG_FILE="${AGENT_DIR}/mind-worker.json"
PI_BIN="${PI_BIN:-pi}"

# ── Use mise-managed node@26 ──
node() { mise x node@26 -- node "$@"; }

# ── Helpers ──

get_cwd_hash()       { echo -n "$1" | sha256sum | cut -c1-16; }
get_manifest_path()  { echo "${STATE_DIR}/$1-manifest.json"; }
get_control_path()   { echo "${STATE_DIR}/$1-mind-control.json"; }
worker_session_dir() { echo "${SESSIONS_DIR}/worker-$1-$2"; }
ensure_dir()         { mkdir -p "$1"; }

# Proper single-quote quoting that handles embedded single quotes in values.
# Replaces each ' with '\'' (end-quote, escaped-quote, resume-quote).
shell_quote() {
	local s="$1"
	s="${s//\'/\'\\\'\'}"
	printf "'%s'" "$s"
}

# Parse pane_id from "herdr pane split" JSON response (stdin).
# Matches the pattern from herdr skill docs:
#   herdr pane split ... | python3 -c 'import sys,json; print(json.load(sys.stdin)["result"]["pane"]["pane_id"])'
parse_pane_id() {
	python3 -c 'import sys,json; print(json.load(sys.stdin)["result"]["pane"]["pane_id"])'
}

# Find the focused pane ID. Uses HERDR_PANE_ID env var (set by herdr for managed panes),
# falls back to parsing "herdr pane list" JSON for the pane with focused=true.
find_focused_pane() {
	local id="${HERDR_PANE_ID:-}"
	if [ -n "$id" ]; then
		echo "$id"
		return 0
	fi
	# Fallback: recursive search of pane list JSON for focused/is_focused/current at any depth
	herdr pane list 2>/dev/null | python3 -c '
import sys, json
d = json.load(sys.stdin)
def find_focused(obj):
    if isinstance(obj, dict):
        if obj.get("focused") or obj.get("is_focused"):
            return obj.get("pane_id") or obj.get("id") or obj.get("paneId") or ""
        for v in obj.values():
            r = find_focused(v)
            if r:
                return r
    elif isinstance(obj, list):
        for item in obj:
            r = find_focused(item)
            if r:
                return r
    return None
r = find_focused(d)
if r:
    print(r)
' 2>/dev/null
}

# ── JSON file ops (via node, env vars for safe value passing) ──

write_manifest() {
	local path="$1" cwd="$2" hash="$3" gen="$4" wc="$5"
	local ws_dir="$(worker_session_dir "$hash" "0")"
	_M_CWD="$cwd" _M_HASH="$hash" _M_GEN="$gen" _M_WC="$wc" _M_WS="$ws_dir" node -e '
		const fs=require("fs");
		fs.writeFileSync(process.argv[1], JSON.stringify({
			cwd: process.env._M_CWD, cwdHash: process.env._M_HASH,
			generation: parseInt(process.env._M_GEN), workerCount: parseInt(process.env._M_WC),
			state:"starting", lastUpdated:Date.now(), startedAt:Date.now(),
			mindPid:null, workerPid:null, mindRole:"mind", workerRole:"worker",
			mindPaneId:null, workerPaneId:null,
			workerSessionDir: process.env._M_WS, mindSessionDir:""
		},null,2));
	' "$path"
}

write_control() {
	local path="$1" gen="$2" status="${3:-}"
	_C_GEN="$gen" _C_STATUS="$status" node -e '
		const fs=require("fs");
		fs.writeFileSync(process.argv[1], JSON.stringify({
			status: process.env._C_STATUS||"", generation: parseInt(process.env._C_GEN),
			lastUpdated:Date.now()
		},null,2));
	' "$path"
}

store_pane_id() {
	local path="$1" key="$2" pid="$3"
	_SP_KEY="$key" _SP_PID="$pid" node -e '
		const fs=require("fs");
		const m=JSON.parse(fs.readFileSync(process.argv[1],"utf-8"));
		m[process.env._SP_KEY]=process.env._SP_PID; m.lastUpdated=Date.now();
		const t=process.argv[1]+".tmp"; fs.writeFileSync(t,JSON.stringify(m,null,2)); fs.renameSync(t,process.argv[1]);
	' "$path"
}

read_manifest_field() {
	local path="$1" key="$2" default="${3:-0}"
	node -e '
		try{const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf-8"));console.log(m[process.argv[2]]??process.argv[3])}
		catch{console.log(process.argv[3])}
	' "$path" "$key" "$default" 2>/dev/null
}

resolve_workers() {
	node -e '
		const fs=require("fs");
		const cfg=JSON.parse(fs.readFileSync(process.argv[1],"utf-8"));
		const resolved=[];
		if(Array.isArray(cfg.workerModels)&&cfg.workerModels.length>0){
			for(const e of cfg.workerModels)for(let i=0;i<e.count;i++)resolved.push({model:e.model,tier:e.tier||"flash"});
		}else{
			const wc=cfg.workerCount||3,wm=cfg.workerModel||"opencode-go/deepseek-v4-flash";
			for(let i=0;i<wc;i++)resolved.push({model:wm,tier:"flash"});
		}
		console.log(JSON.stringify(resolved));
	' "$CONFIG_FILE"
}

config_get() {
	local key="$1" default="${2:-}"
	node -e '
		try{const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf-8"));console.log(c[process.argv[2]]!==undefined?c[process.argv[2]]:process.argv[3])}
		catch{console.log(process.argv[3])}
	' "$CONFIG_FILE" "$key" "$default" 2>/dev/null
}

# ── Wait for mind ready (poll control file + socket) ──
wait_mind_ready() {
	local hash="$1" gen="$2" timeout="${3:-60}"
	local cp socket deadline
	cp="$(get_control_path "$hash")"
	socket="${STATE_DIR}/${hash}.sock"
	deadline=$(($(date +%s) + timeout))

	while [ "$(date +%s)" -lt "$deadline" ]; do
		if [ -f "$cp" ]; then
			local status
			status="$(node -e '
				try{const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf-8"));
				if(d.generation===parseInt(process.argv[2])&&(d.status==="ready"||d.status==="worker-connected"))console.log("ok")}
				catch{}
			' "$cp" "$gen" 2>/dev/null)"
			if [ "$status" = "ok" ] && [ -S "$socket" ]; then
				node -e '
					const net=require("net"); const s=net.createConnection(process.argv[1],()=>{s.destroy();process.exit(0)});
					s.on("error",()=>process.exit(1)); s.setTimeout(2000,()=>{s.destroy();process.exit(1)});
				' "$socket" 2>/dev/null && return 0
			fi
		fi
		sleep 0.5
	done
	return 1
}

# ── Wait for worker-connected with expected count ──
wait_workers_connected() {
	local hash="$1" gen="$2" expected="$3" timeout="${4:-60}"
	local cp deadline
	cp="$(get_control_path "$hash")"
	deadline=$(($(date +%s) + timeout))

	while [ "$(date +%s)" -lt "$deadline" ]; do
		if [ -f "$cp" ]; then
			local connected
			connected="$(node -e '
				try{const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf-8"));
				if(d.generation===parseInt(process.argv[2])&&d.status==="worker-connected")console.log(d.connectedWorkers||0)}
				catch{console.log(0)}
			' "$cp" "$gen" 2>/dev/null)"
			if [ "${connected:-0}" -ge "$expected" ]; then return 0; fi
		fi
		sleep 0.5
	done
	return 1
}

# ── Close panes from manifest (for reset) ──
close_manifest_panes() {
	local mp="$1"
	[ ! -f "$mp" ] && return 0
	node -e '
		const fs=require("fs"),cp=require("child_process");
		try{
			const m=JSON.parse(fs.readFileSync(process.argv[1],"utf-8"));
			const ids=[];
			if(m.mindPaneId)ids.push(m.mindPaneId);
			for(const k of Object.keys(m))if(k.startsWith("workerPaneId_"))ids.push(m[k]);
			for(const id of ids){try{cp.execSync("herdr pane close "+id,{timeout:5000,stdio:"ignore"})}catch(e){}}
		}catch(e){}
	' "$mp" 2>/dev/null || true
}

# ── Check if pair appears live (control file, manifest, socket) ──
is_pair_live() {
	local hash="$1" cp mp socket
	cp="$(get_control_path "$hash")"
	mp="$(get_manifest_path "$hash")"
	socket="${STATE_DIR}/${hash}.sock"

	# Control file with ready/busy/starting/worker-connected status
	if [ -f "$cp" ]; then
		local st
		st="$(node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf-8")).status||"")}catch{console.log("")}' "$cp" 2>/dev/null)"
		case "$st" in ready|busy|starting|worker-connected) return 0 ;; esac
	fi
	# Manifest with running/starting state
	if [ -f "$mp" ]; then
		local st
		st="$(node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf-8")).state||"")}catch{console.log("")}' "$mp" 2>/dev/null)"
		case "$st" in running|starting) return 0 ;; esac
	fi
	# Socket file exists
	[ -S "$socket" ] && return 0
	return 1
}

# ── Build env-prefixed command string for pane run ──
# Sets PI_MIND_WORKER_* env vars via "env KEY=VAL ... pi ..." so the TUI inherits them.
build_mind_cmd() {
	local gen="$1" model="$2" cwd="$3"
	local cmd="cd $(shell_quote "$cwd") && env PI_MIND_WORKER_ROLE=mind PI_MIND_WORKER_GENERATION=${gen} ${PI_BIN}"
	[ -n "$model" ] && cmd="${cmd} --model $(shell_quote "$model")"
	echo "$cmd"
}

build_worker_cmd() {
	local gen="$1" worker_id="$2" tier="$3" model="$4" session_dir="$5" cwd="$6"
	local cmd="cd $(shell_quote "$cwd") && env PI_MIND_WORKER_ROLE=worker PI_MIND_WORKER_GENERATION=${gen} PI_MIND_WORKER_ID=${worker_id} PI_MIND_WORKER_TIER=${tier} PI_MIND_WORKER_SESSION_DIR=$(shell_quote "$session_dir") ${PI_BIN}"
	cmd="${cmd} --model $(shell_quote "$model") --session-dir $(shell_quote "$session_dir")"
	echo "$cmd"
}

# ── Main ──

main() {
	local reset_flag=false explicit_cwd=""

	while [[ $# -gt 0 ]]; do
		case "$1" in
			--reset) reset_flag=true ;;
			--cwd) explicit_cwd="$2"; shift ;;
		esac
		shift
	done

	local cwd hash
	cwd="$(realpath "${explicit_cwd:-$PWD}")"
	hash="$(get_cwd_hash "$cwd")"

	ensure_dir "$STATE_DIR"
	ensure_dir "$SESSIONS_DIR"

	# Load config
	local mind_model
	mind_model="$(config_get "mindModel" "")"

	# Resolve workers
	local workers_json worker_count
	workers_json="$(resolve_workers)"
	worker_count="$(echo "$workers_json" | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).length))')"

	local mp cp
	mp="$(get_manifest_path "$hash")"
	cp="$(get_control_path "$hash")"

	# ── Determine generation ──
	# Always increment from previous manifest if present; reset cleans up artifacts
	# but preserves the generation counter so it keeps climbing.
	local generation=1
	if [ -f "$mp" ]; then
		generation="$(read_manifest_field "$mp" "generation" "0")"
		generation=$((generation + 1))
	fi

	# ── Reset path ──
	if $reset_flag; then
		echo "=== Reset (herdr) ==="
		echo "  Previous generation: $((generation - 1))"
		if [ -f "$mp" ]; then
			close_manifest_panes "$mp"
			sleep 1
		fi
		# Cleanup all artifacts
		rm -f "$mp" "$cp" "${STATE_DIR}/${hash}.sock" "${STATE_DIR}/${hash}"-*
		for d in "${SESSIONS_DIR}/worker-${hash}"-*; do
			[ -d "$d" ] && rm -rf "$d" 2>/dev/null || true
		done
		for d in "${SESSIONS_DIR}/burst-flash-${hash}"-*; do
			[ -d "$d" ] && rm -rf "$d" 2>/dev/null || true
		done
	# ── Auto-reset if pair already live ──
	elif is_pair_live "$hash"; then
		echo "Pair already running for hash ${hash}. Running reset..."
		# ponytail: use array for safe exec quoting
		local -a exec_args=("$0" "--reset")
		[ -n "$explicit_cwd" ] && exec_args+=("--cwd" "$explicit_cwd")
		exec "${exec_args[@]}"
	fi

	echo "=== Mind-Pair Launcher (herdr) ==="
	echo "  CWD:     $cwd"
	echo "  Hash:    $hash"
	echo "  Gen:     $generation"
	echo "  Workers: $worker_count"

	# ── Write fresh manifest + control ──
	write_manifest "$mp" "$cwd" "$hash" "$generation" "$worker_count"
	write_control "$cp" "$generation" ""

	# ── Worker session dirs ──
	for i in $(seq 0 $((worker_count - 1))); do
		ensure_dir "$(worker_session_dir "$hash" "$i")"
	done

	# ── Get current (launcher) pane ──
	local my_pane
	my_pane="$(find_focused_pane)"
	if [ -z "$my_pane" ]; then
		echo "ERROR: Could not determine current herdr pane. Is HERDR_ENV=1?" >&2
		exit 1
	fi
	echo "  Launcher pane: $my_pane"

	# ── Spawn mind pane (split right from launcher) ──
	echo "  Spawning mind pane..."
	local mind_pane
	mind_pane="$(herdr pane split "$my_pane" --direction right --no-focus | parse_pane_id)"

	if [ -z "$mind_pane" ]; then
		echo "ERROR: Failed to create mind pane" >&2
		exit 1
	fi

	store_pane_id "$mp" "mindPaneId" "$mind_pane"

	# Launch pi in mind pane via env-prefixed command
	local mind_cmd
	mind_cmd="$(build_mind_cmd "$generation" "$mind_model" "$cwd")"
	herdr pane run "$mind_pane" "$mind_cmd"

	# ── Wait for mind ready ──
	echo "  Waiting for mind to be ready..."
	if ! wait_mind_ready "$hash" "$generation" 60; then
		echo "ERROR: Mind did not become ready within 60s" >&2
		herdr pane close "$mind_pane" 2>/dev/null || true
		exit 1
	fi
	echo "  Mind is ready."

	# ── Spawn worker panes (split right from mind pane) ──
	echo "  Spawning $worker_count worker panes..."
	local worker_panes=()

	for i in $(seq 0 $((worker_count - 1))); do
		local w_model w_tier w_session w_label
		w_model="$(echo "$workers_json" | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d)[$i].model))")"
		w_tier="$(echo "$workers_json" | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d)[$i].tier))")"
		w_session="$(worker_session_dir "$hash" "$i")"
		w_label="worker-${i}"

		local w_pane
		w_pane="$(herdr pane split "$mind_pane" --direction right --no-focus | parse_pane_id)"

		if [ -z "$w_pane" ]; then
			echo "  WARNING: Failed to create worker $i pane, skipping" >&2
			continue
		fi

		store_pane_id "$mp" "workerPaneId_${i}" "$w_pane"

		local w_cmd
		w_cmd="$(build_worker_cmd "$generation" "$w_label" "$w_tier" "$w_model" "$w_session" "$cwd")"
		herdr pane run "$w_pane" "$w_cmd"
		worker_panes+=("$w_pane")
		echo "    Worker $i: $w_pane ($w_tier)"
	done

	# ponytail: if no workers spawned successfully, fail early
	if [ "${#worker_panes[@]}" -eq 0 ]; then
		echo "ERROR: No worker panes created" >&2
		herdr pane close "$mind_pane" 2>/dev/null || true
		exit 1
	fi

	# ── Wait for all workers connected ──
	local wait_timeout=$((10 + worker_count * 5))
	echo "  Waiting for ${#worker_panes[@]} workers to connect (timeout ${wait_timeout}s)..."
	if ! wait_workers_connected "$hash" "$generation" "${#worker_panes[@]}" "$wait_timeout"; then
		echo "ERROR: Not all workers connected within ${wait_timeout}s" >&2
		herdr pane close "$mind_pane" 2>/dev/null || true
		for wp in "${worker_panes[@]}"; do
			herdr pane close "$wp" 2>/dev/null || true
		done
		exit 1
	fi

	echo "=== Mind-pair started (herdr, gen $generation) ==="
	echo "  Mind:    $mind_pane"
	echo "  Workers: ${worker_panes[*]}"
	echo "  Cwd:     $cwd"
}

main "$@"
