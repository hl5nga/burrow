# Reports each command and prompt to Burrow as OSC 9999, which the app consumes
# before rendering:  ESC ] 9999 ; <event> ; base64(<field> NUL <field> NUL ...) BEL
#   exec   : host, cwd, command line        (preexec — right before a command runs)
#   prompt : host, cwd, exit status, git branch (precmd — right before the prompt)
#   guardrail : severity, command line, rule label (a rule matched on Enter)
[[ -o interactive ]] || return
(( ${+__burrow_hooks_loaded} )) && return
typeset -g __burrow_hooks_loaded=1
# This file's directory: the wrappers and the generated guardrails.zsh live here.
typeset -g __burrow_dir=${${(%):-%x}:A:h}

# tmux drops unknown OSC sequences. Wrapped in its DCS passthrough envelope they
# reach the outer terminal, but only with allow-passthrough on — set here for this
# pane alone (runtime only; the user's tmux.conf is untouched).
if [[ -n $TMUX ]]; then
  command tmux set -p allow-passthrough on 2>/dev/null
fi

__burrow_emit() {
  local event=$1
  shift
  local payload
  payload=$(printf '%s\0' "$@" | base64 | tr -d '\n')
  if [[ -n $TMUX ]]; then
    printf '\ePtmux;\e\e]9999;%s;%s\a\e\\' "$event" "$payload"
  else
    printf '\e]9999;%s;%s\a' "$event" "$payload"
  fi
}

__burrow_preexec() {
  __burrow_emit exec "$HOST" "$PWD" "$1"
}

# Current git branch without forking git: walk up to .git and read HEAD.
# Prints nothing outside a repository; a short commit id when HEAD is detached.
__burrow_git_branch() {
  local dir=$PWD gitdir head
  while :; do
    if [[ -d $dir/.git ]]; then
      gitdir=$dir/.git
      break
    elif [[ -f $dir/.git ]]; then
      # Worktrees and submodules: ".git" is a file holding "gitdir: <path>".
      gitdir=$(<$dir/.git)
      gitdir=${gitdir#gitdir: }
      [[ $gitdir == /* ]] || gitdir=$dir/$gitdir
      break
    fi
    [[ $dir == / || -z $dir ]] && return
    dir=${dir:h}
  done
  [[ -r $gitdir/HEAD ]] || return
  head=$(<$gitdir/HEAD)
  if [[ $head == "ref: refs/heads/"* ]]; then
    print -rn -- ${head#ref: refs/heads/}
  else
    print -rn -- ${head[1,7]}
  fi
}

__burrow_precmd() {
  local exit_status=$?
  __burrow_emit prompt "$HOST" "$PWD" "$exit_status" "$(__burrow_git_branch)"
  (( $+functions[__burrow_guard_load] )) && __burrow_guard_load
}

autoload -Uz add-zsh-hook
add-zsh-hook preexec __burrow_preexec
# First in line, so $? is still the command's status and not another hook's.
precmd_functions=(__burrow_precmd ${precmd_functions:#__burrow_precmd})

# ---------- Guardrails ----------
# Wraps ZLE's accept-line, the one point every command line passes through before
# it runs — typed, pasted, or sent by Burrow's palette alike. Rules come from
# guardrails.zsh, which Burrow generates from guardrails.json; they are zsh `=~`
# patterns, i.e. POSIX extended regular expressions.
typeset -ga __burrow_guard_patterns __burrow_guard_severity __burrow_guard_labels
typeset -g __burrow_guard_confirmed="" __burrow_guard_stamp=""

__burrow_guard_load() {
  # BURROW_GUARDRAILS points elsewhere only in tests.
  local file=${BURROW_GUARDRAILS:-$__burrow_dir/guardrails.zsh} stamp
  [[ -r $file ]] || return
  # Re-read only when Burrow rewrote the file (its first line carries a stamp).
  stamp=${${(f)"$(<$file)"}[1]}
  [[ $stamp == "$__burrow_guard_stamp" ]] && return
  source "$file" && __burrow_guard_stamp=$stamp
}

__burrow_guard_accept_line() {
  local i warned=0
  if [[ -n ${BUFFER//[[:space:]]/} ]]; then
    # Every block rule first: a warn rule earlier in the list must not wave
    # through a line that a later block rule stops.
    for i in {1..${#__burrow_guard_patterns}}; do
      [[ ${__burrow_guard_severity[i]} == block ]] || continue
      [[ $BUFFER =~ ${__burrow_guard_patterns[i]} ]] 2>/dev/null || continue
      # Second Enter on the unchanged line: the user confirmed it.
      [[ $BUFFER == "$__burrow_guard_confirmed" ]] && break
      __burrow_guard_confirmed=$BUFFER
      __burrow_emit guardrail block "$BUFFER" "${__burrow_guard_labels[i]}"
      zle -M "⛔ 가드레일: ${__burrow_guard_labels[i]} — 실행하려면 Enter를 한 번 더, 취소는 Ctrl-C"
      return 0
    done
    for i in {1..${#__burrow_guard_patterns}}; do
      [[ ${__burrow_guard_severity[i]} == warn ]] || continue
      [[ $BUFFER =~ ${__burrow_guard_patterns[i]} ]] 2>/dev/null || continue
      __burrow_emit guardrail warn "$BUFFER" "${__burrow_guard_labels[i]}"
      zle -I
      print -r -- $'\e[33m⚠ 가드레일: '"${__burrow_guard_labels[i]}"$'\e[0m'
      break
    done
  fi
  __burrow_guard_confirmed=""
  zle __burrow_orig_accept_line
}

__burrow_guard_install() {
  __burrow_guard_load
  # Wrap once. Plugins that wrap accept-line later (autosuggestions, syntax
  # highlighting) wrap this widget in turn, so every layer still runs.
  if [[ ${widgets[accept-line]} != user:__burrow_guard_accept_line ]] && (( ! ${+widgets[__burrow_orig_accept_line]} )); then
    zle -A accept-line __burrow_orig_accept_line
    zle -N accept-line __burrow_guard_accept_line
  fi
}

zmodload zsh/zleparameter 2>/dev/null
__burrow_guard_install
