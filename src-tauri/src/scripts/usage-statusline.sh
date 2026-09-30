#!/bin/sh
# Burrow: Claude Code runs this as its status line and pipes it a JSON blob on
# stdin, which includes the account's rate-limit usage. Keep the latest blob so
# Burrow can show the 5-hour and weekly percentages. Prints nothing, so Claude
# Code shows no status line of its own.
d="$HOME/.burrow"
umask 077
mkdir -p "$d" 2>/dev/null
t="$d/usage.json.$$"
cat > "$t" && mv "$t" "$d/usage.json"
exit 0
