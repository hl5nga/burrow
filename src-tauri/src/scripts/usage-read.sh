# Prints what Burrow needs to know about Claude Code usage on this host.
f="$HOME/.burrow/usage.json"
s="$HOME/.claude/settings.json"
if [ -f "$HOME/.burrow/usage-statusline.sh" ] && grep -q "usage-statusline.sh" "$s" 2>/dev/null; then
  echo "burrow:installed:1"
else
  echo "burrow:installed:0"
fi
echo "burrow:now:$(date +%s)"
if [ -f "$f" ]; then
  echo "burrow:mtime:$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f" 2>/dev/null)"
  printf 'burrow:json:'
  tr -d '\n' < "$f"
  echo
fi
