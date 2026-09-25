# Burrow puts ZDOTDIR on this directory so it can add its hooks without editing
# the user's dotfiles. Each wrapper sources the user's own file with ZDOTDIR set
# the way the user had it, then points ZDOTDIR back here for the next file.
__burrow_wrapper=$ZDOTDIR
if (( ${+BURROW_USER_ZDOTDIR} )); then
  ZDOTDIR=$BURROW_USER_ZDOTDIR
else
  unset ZDOTDIR
fi
unset BURROW_USER_ZDOTDIR

[[ -f ${ZDOTDIR:-$HOME}/.zshenv ]] && source "${ZDOTDIR:-$HOME}/.zshenv"

# The user's .zshenv may itself set ZDOTDIR (e.g. an XDG layout); remember that.
__burrow_user_zdotdir_set=${+ZDOTDIR}
__burrow_user_zdotdir=$ZDOTDIR
__burrow_use_user_zdotdir() {
  if (( __burrow_user_zdotdir_set )); then
    ZDOTDIR=$__burrow_user_zdotdir
  else
    unset ZDOTDIR
  fi
}
ZDOTDIR=$__burrow_wrapper
