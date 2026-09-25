# Reports each command and prompt to Burrow as OSC 9999, which the app consumes
# before rendering:  ESC ] 9999 ; <event> ; base64(<field> NUL <field> NUL ...) BEL
#   exec   : host, cwd, command line        (preexec — right before a command runs)
#   prompt : host, cwd, exit status, git branch (precmd — right before the prompt)
[[ -o interactive ]] || return
(( ${+__burrow_hooks_loaded} )) && return
typeset -g __burrow_hooks_loaded=1

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
}

autoload -Uz add-zsh-hook
add-zsh-hook preexec __burrow_preexec
# First in line, so $? is still the command's status and not another hook's.
precmd_functions=(__burrow_precmd ${precmd_functions:#__burrow_precmd})
