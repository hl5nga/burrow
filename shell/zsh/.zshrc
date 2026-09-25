__burrow_use_user_zdotdir
# macOS /etc/zshrc ran while ZDOTDIR still pointed here and derived paths from it;
# point them at the user's directory so history and key maps stay the user's own.
[[ $HISTFILE == "$__burrow_wrapper/.zsh_history" ]] && HISTFILE=${ZDOTDIR:-$HOME}/.zsh_history
[[ -r ${ZDOTDIR:-$HOME}/.zkbd/${TERM}-${VENDOR} ]] && source "${ZDOTDIR:-$HOME}/.zkbd/${TERM}-${VENDOR}"
[[ -f ${ZDOTDIR:-$HOME}/.zshrc ]] && source "${ZDOTDIR:-$HOME}/.zshrc"
source "$__burrow_wrapper/burrow-hooks.zsh"
# ZDOTDIR stays as the user had it: zsh then reads the user's own .zlogin, and
# shells started from this one behave exactly as outside Burrow.
unset __burrow_wrapper __burrow_user_zdotdir __burrow_user_zdotdir_set
unfunction __burrow_use_user_zdotdir
