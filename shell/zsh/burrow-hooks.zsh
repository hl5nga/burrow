# Reports each command and prompt to Burrow as OSC 9999, which the app consumes
# before rendering:  ESC ] 9999 ; <event> ; base64(<field> NUL <field> NUL ...) BEL
#   exec   : host, cwd, command line        (preexec — right before a command runs)
#   prompt : host, cwd, exit status          (precmd — right before the prompt)
[[ -o interactive ]] || return
(( ${+__burrow_hooks_loaded} )) && return
typeset -g __burrow_hooks_loaded=1

__burrow_emit() {
  local event=$1
  shift
  printf '\e]9999;%s;%s\a' "$event" "$(printf '%s\0' "$@" | base64 | tr -d '\n')"
}

__burrow_preexec() {
  __burrow_emit exec "$HOST" "$PWD" "$1"
}

__burrow_precmd() {
  local exit_status=$?
  __burrow_emit prompt "$HOST" "$PWD" "$exit_status"
}

autoload -Uz add-zsh-hook
add-zsh-hook preexec __burrow_preexec
# First in line, so $? is still the command's status and not another hook's.
precmd_functions=(__burrow_precmd ${precmd_functions:#__burrow_precmd})
