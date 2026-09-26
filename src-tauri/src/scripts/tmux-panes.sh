# Lists every tmux pane on the host with the bottom of its screen, for the
# agent dashboard. Read-only: nothing inside the panes or tmux.conf changes.
# Non-interactive ssh lacks Homebrew's PATH, so look there as well.
T=$(command -v tmux 2>/dev/null)
[ -n "$T" ] || for d in /opt/homebrew/bin /usr/local/bin; do [ -x "$d/tmux" ] && T=$d/tmux && break; done
[ -n "$T" ] || { echo burrow:no-tmux; exit 0; }
# tmux turns tabs in -F output into "_", so: fixed space-separated fields, then
# the command and the session name (either may contain spaces) around a marker.
panes=$("$T" list-panes -a -F 'burrow:pane #{pane_id} #{window_index} #{pane_index} #{pane_active} #{window_active} #{pane_current_command}::burrow::#{session_name}' 2>/dev/null) || { echo burrow:no-server; exit 0; }
printf '%s\n' "$panes"
printf '%s\n' "$panes" | cut -d' ' -f2 | while read -r id; do
  echo "burrow:capture $id"
  "$T" capture-pane -p -J -t "$id" -S -30 2>/dev/null | sed 's/^/|/'
done
