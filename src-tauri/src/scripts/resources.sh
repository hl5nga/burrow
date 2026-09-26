# Samples CPU and memory for the resource chip. Runs locally with `sh -s` and on
# remote hosts over the ssh side channel, so both report the same measure.
# CPU is busy % over one second; memory is what Activity Monitor calls
# "Memory Used" on macOS (app + wired + compressed) and total - MemAvailable on
# Linux. Lines are tagged because login files may print their own output.
case "$(uname -s)" in
Darwin)
  iostat -n 0 -c 2 -w 1 | tail -1 | awk '{print "burrow:cpu:" 100 - $3}'
  echo "burrow:cores:$(sysctl -n hw.ncpu)"
  echo "burrow:mem-total:$(sysctl -n hw.memsize)"
  vm_stat | awk '/page size of/ {ps=$8} /^Anonymous pages/ {a=$3} /^Pages purgeable/ {p=$3} /^Pages wired down/ {w=$4} /occupied by compressor/ {c=$5} END {print "burrow:mem-used:" (a-p+w+c)*ps}'
  ;;
Linux)
  a=$(head -1 /proc/stat); sleep 1; b=$(head -1 /proc/stat)
  printf '%s\n%s\n' "$a" "$b" | awk '{idle=$5+$6; tot=0; for(i=2;i<=NF;i++) tot+=$i; if (NR==1) {i0=idle; t0=tot} else if (tot>t0) printf "burrow:cpu:%.1f\n", 100*(1-(idle-i0)/(tot-t0))}'
  echo "burrow:cores:$(grep -c ^processor /proc/cpuinfo)"
  awk '/^MemTotal:/ {t=$2} /^MemAvailable:/ {a=$2} END {print "burrow:mem-total:" t*1024; print "burrow:mem-used:" (t-a)*1024}' /proc/meminfo
  ;;
esac
